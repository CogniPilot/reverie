//! Real bind-source anchors, retained through each contiguous effect phase.
use super::*;
use reverie_host::deployment_snapshot::ObservedPath;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{os::unix::fs::MetadataExt, path::PathBuf};
mod socket;

enum Anchor {
    Ordinary(ObservedPath),
    Engine(socket::EngineSocket),
}
impl Anchor {
    fn capture(path: &std::path::Path, destination: &str, readonly: bool) -> Result<Self> {
        if socket::fixed_scope(path, destination) {
            require(readonly, "DEPLOYMENT_ENGINE_BIND_NOT_READONLY")?;
            return Ok(Self::Engine(socket::EngineSocket::capture(
                path,
                destination,
            )?));
        }
        Ok(Self::Ordinary(ObservedPath::capture(path).map_err(
            |_| DeploymentError::new("DEPLOYMENT_BIND_PIN_REFUSED"),
        )?))
    }
    fn verify(&self) -> Result<()> {
        match self {
            Self::Ordinary(value) => value
                .verify()
                .map_err(|_| DeploymentError::new("DEPLOYMENT_BIND_CHANGED")),
            Self::Engine(value) => value.verify(),
        }
    }
    fn identity(&self, path: PathBuf) -> Result<Identity> {
        match self {
            Self::Ordinary(value) => {
                let identity = Identity::capture(path)?;
                require(
                    value.identity() == (identity.device, identity.inode),
                    "DEPLOYMENT_BIND_CHANGED",
                )?;
                Ok(identity)
            }
            Self::Engine(value) => value.identity(),
        }
    }
    fn inside(&self, path: &std::path::Path, expected: &Identity) -> Result<()> {
        match self {
            Self::Ordinary(_) => {
                let actual = std::fs::metadata(path)?;
                require(
                    (actual.dev(), actual.ino()) == (expected.device, expected.inode),
                    "DEPLOYMENT_RUNNING_BIND_CHANGED",
                )
            }
            Self::Engine(value) => value.inside(path),
        }
    }
    fn close(self) -> Result<()> {
        match self {
            Self::Ordinary(value) => value
                .close()
                .map_err(|_| DeploymentError::new("DEPLOYMENT_BIND_CLOSE_UNCONFIRMED")),
            Self::Engine(value) => value.close(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Identity {
    path: PathBuf,
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    file_generation: Option<(u64, i64, i64, i64, i64)>,
}
impl Identity {
    fn capture(path: PathBuf) -> Result<Self> {
        let m = std::fs::metadata(&path)?;
        require(
            m.is_dir() || m.is_file(),
            "DEPLOYMENT_BIND_TYPE_UNSUPPORTED",
        )?;
        Ok(Self {
            path,
            device: m.dev(),
            inode: m.ino(),
            uid: m.uid(),
            gid: m.gid(),
            mode: m.mode(),
            file_generation: m.is_file().then_some((
                m.len(),
                m.mtime(),
                m.mtime_nsec(),
                m.ctime(),
                m.ctime_nsec(),
            )),
        })
    }
}
pub(super) struct Pins {
    entries: Vec<(Anchor, Identity, String)>,
}
impl Pins {
    pub(super) fn capture(source: &Value) -> Result<Self> {
        let mut owner = Self {
            entries: Vec::new(),
        };
        let result = owner.initialize(source);
        match result {
            Ok(()) => Ok(owner),
            Err(error) => DeploymentError::finalized(Err(error), owner.close()),
        }
    }
    fn initialize(&mut self, source: &Value) -> Result<()> {
        model::observed_mounts(source)?;
        let mounts = source["Mounts"]
            .as_array()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_MOUNTS_REQUIRED"))?;
        for mount in mounts {
            if mount["Type"] == "tmpfs" {
                continue;
            }
            let path = PathBuf::from(model::string(mount, "Source")?);
            let destination = model::string(mount, "Destination")?.to_owned();
            let held = Anchor::capture(&path, &destination, mount["RW"] == false)?;
            // Adopt before the next fallible observation.
            let placeholder = Identity {
                path: path.clone(),
                device: 0,
                inode: 0,
                uid: 0,
                gid: 0,
                mode: 0,
                file_generation: None,
            };
            self.entries.push((held, placeholder, destination));
            let entry = self.entries.last_mut().expect("adopted bind owner");
            entry.1 = entry.0.identity(path)?;
        }
        self.verify()
    }
    pub(super) fn identities(&self) -> Vec<Identity> {
        self.entries.iter().map(|(_, i, _)| i.clone()).collect()
    }
    pub(super) fn matches(&self, expected: &[Identity]) -> Result<()> {
        require(self.identities() == expected, "DEPLOYMENT_BIND_CHANGED")?;
        self.verify()
    }
    pub(super) fn verify(&self) -> Result<()> {
        for (held, expected, _) in &self.entries {
            held.verify()?;
            require(
                &held.identity(expected.path.clone())? == expected,
                "DEPLOYMENT_BIND_CHANGED",
            )?;
        }
        Ok(())
    }
    pub(super) fn running_mounts(&self, container: &Value) -> Result<()> {
        // Fixed ephemeral mounts have no host source to pin. Validate their
        // complete profile separately, while retaining every real bind anchor.
        model::observed_mounts(container)?;
        self.verify()?;
        let pid = container["State"]["Pid"]
            .as_u64()
            .filter(|p| *p > 0)
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_PROCESS_UNKNOWN"))?;
        for (held, expected, destination) in &self.entries {
            let inside = PathBuf::from(format!("/proc/{pid}/root"))
                .join(destination.trim_start_matches('/'));
            held.inside(&inside, expected)?;
        }
        self.verify()?;
        model::observed_mounts(container)
    }
    pub(super) fn close(self) -> Result<()> {
        let mut result = Ok(());
        for (held, _, _) in self.entries {
            result = DeploymentError::finalized(result, held.close());
        }
        result
    }
}
