//! Read-only custody of the one existing Engine bind. This pins filesystem
//! identity only; Engine::exchange independently authenticates its root peer.
use super::{DeploymentError, Identity, Result, require};
use nix::fcntl::{OFlag, open};
use nix::sys::stat::Mode;
use std::{
    fs::{self, File, Metadata},
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
};

const CANONICAL: &str = "/run/docker.sock";
const ALIAS: &str = "/var/run/docker.sock";
const DESTINATION: &str = "/run/reverie-engine/docker.sock";
const CHANGED: &str = "DEPLOYMENT_ENGINE_BIND_CHANGED";

#[cfg(test)]
mod tests;

pub(super) fn fixed_scope(path: &Path, destination: &str) -> bool {
    path == Path::new(CANONICAL) || path == Path::new(ALIAS) || destination == DESTINATION
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    device: u64,
    inode: u64,
    rdev: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}
impl Stamp {
    fn of(info: &Metadata) -> Self {
        Self {
            device: info.dev(),
            inode: info.ino(),
            rdev: info.rdev(),
            uid: info.uid(),
            gid: info.gid(),
            mode: info.mode(),
        }
    }
}
struct Entry {
    path: PathBuf,
    file: File,
    stamp: Stamp,
}
fn close(file: File) -> Result<()> {
    nix::unistd::close(file).map_err(|_| DeploymentError::new("DEPLOYMENT_BIND_CLOSE_UNCONFIRMED"))
}
fn opened(path: &Path) -> Result<File> {
    open(
        path,
        OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| DeploymentError::new(CHANGED))
}
impl Entry {
    fn capture(path: &Path, socket: bool) -> Result<Self> {
        let file = opened(path)?;
        let result = (|| {
            let info = file.metadata()?;
            require(info.uid() == 0, CHANGED)?;
            if socket {
                require(
                    info.file_type().is_socket() && matches!(info.mode() & 0o7777, 0o600 | 0o660),
                    CHANGED,
                )?;
            } else {
                let alias = path == Path::new("/var/run") && info.file_type().is_symlink();
                require(
                    alias || (info.is_dir() && info.mode() & 0o022 == 0),
                    CHANGED,
                )?;
            }
            Ok(Stamp::of(&info))
        })();
        match result {
            Ok(stamp) => Ok(Self {
                path: path.to_path_buf(),
                file,
                stamp,
            }),
            Err(error) => DeploymentError::finalized(Err(error), close(file)),
        }
    }
    fn verify(&self) -> Result<()> {
        require(
            Stamp::of(&self.file.metadata()?) == self.stamp
                && Stamp::of(&fs::symlink_metadata(&self.path)?) == self.stamp,
            CHANGED,
        )
    }
}

pub(super) struct EngineSocket {
    original: PathBuf,
    endpoint: Entry,
    parents: Vec<Entry>,
}
impl EngineSocket {
    pub(super) fn capture(path: &Path, destination: &str) -> Result<Self> {
        require(
            (path == Path::new(CANONICAL) || path == Path::new(ALIAS))
                && destination == DESTINATION,
            "DEPLOYMENT_ENGINE_BIND_SCOPE",
        )?;
        require(fs::canonicalize(path)? == Path::new(CANONICAL), CHANGED)?;
        let mut parents = Vec::new();
        let names: &[&str] = if path == Path::new(ALIAS) {
            &["/", "/run", "/var", "/var/run"]
        } else {
            &["/", "/run"]
        };
        let result = (|| {
            for parent in names {
                parents.push(Entry::capture(Path::new(parent), false)?);
            }
            Entry::capture(Path::new(CANONICAL), true)
        })();
        let endpoint = match result {
            Ok(endpoint) => endpoint,
            Err(error) => return DeploymentError::finalized(Err(error), close_parents(parents)),
        };
        let held = Self {
            original: path.to_path_buf(),
            endpoint,
            parents,
        };
        match held.verify() {
            Ok(()) => Ok(held),
            Err(error) => DeploymentError::finalized(Err(error), held.close()),
        }
    }
    pub(super) fn verify(&self) -> Result<()> {
        for parent in &self.parents {
            parent.verify()?;
        }
        self.endpoint.verify()?;
        require(
            fs::canonicalize(&self.original)? == Path::new(CANONICAL),
            CHANGED,
        )
    }
    pub(super) fn identity(&self) -> Result<Identity> {
        self.verify()?;
        let s = self.endpoint.stamp;
        Ok(Identity {
            path: self.original.clone(),
            device: s.device,
            inode: s.inode,
            uid: s.uid,
            gid: s.gid,
            mode: s.mode,
            file_generation: None,
        })
    }
    pub(super) fn inside(&self, path: &Path) -> Result<()> {
        self.verify()?;
        let file = opened(path)?;
        let result = (|| {
            require(
                Stamp::of(&file.metadata()?) == self.endpoint.stamp
                    && Stamp::of(&fs::symlink_metadata(path)?) == self.endpoint.stamp,
                "DEPLOYMENT_RUNNING_BIND_CHANGED",
            )?;
            self.verify()
        })();
        DeploymentError::finalized(result, close(file))
    }
    pub(super) fn close(self) -> Result<()> {
        DeploymentError::finalized(close(self.endpoint.file), close_parents(self.parents))
    }
}
fn close_parents(parents: Vec<Entry>) -> Result<()> {
    let mut result = Ok(());
    for parent in parents {
        result = DeploymentError::finalized(result, close(parent.file));
    }
    result
}
