//! Real bind-source anchors, retained through each contiguous effect phase.
use super::*;
use reverie_host::deployment_snapshot::ObservedPath;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{os::unix::fs::MetadataExt, path::PathBuf};

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
    entries: Vec<(ObservedPath, Identity, String)>,
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
            let held = ObservedPath::capture(&path)
                .map_err(|_| DeploymentError::new("DEPLOYMENT_BIND_PIN_REFUSED"))?;
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
            entry.1 = Identity::capture(path)?;
            require(
                entry.0.identity() == (entry.1.device, entry.1.inode),
                "DEPLOYMENT_BIND_CHANGED",
            )?;
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
            held.verify()
                .map_err(|_| DeploymentError::new("DEPLOYMENT_BIND_CHANGED"))?;
            require(
                &Identity::capture(expected.path.clone())? == expected,
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
        for (_, expected, destination) in &self.entries {
            let inside = PathBuf::from(format!("/proc/{pid}/root"))
                .join(destination.trim_start_matches('/'));
            let actual = std::fs::metadata(inside)?;
            require(
                (actual.dev(), actual.ino()) == (expected.device, expected.inode),
                "DEPLOYMENT_RUNNING_BIND_CHANGED",
            )?;
        }
        self.verify()?;
        model::observed_mounts(container)
    }
    pub(super) fn close(self) -> Result<()> {
        let mut result = Ok(());
        for (held, _, _) in self.entries {
            result = DeploymentError::finalized(
                result,
                held.close()
                    .map_err(|_| DeploymentError::new("DEPLOYMENT_BIND_CLOSE_UNCONFIRMED")),
            );
        }
        result
    }
}
