//! Owned task workspaces with the contract of `python/reverie/workspaces.py`:
//! one owned root, a non-blocking operation lock per workspace, a durable
//! `.reverie-task.json` and the workspace's lease reservation. The operation
//! lock is a mutex between operations on one workspace, not a lease.
use crate::lease::{self, LeaseBase, LeaseError};
use nix::fcntl::{Flock, FlockArg};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;
#[cfg(test)]
mod tests;

/// The marker that makes a root this module's own.
pub const OWNED_MARKER: &str = ".reverie-owned";
/// The workspace metadata file.
pub const METADATA: &str = ".reverie-task.json";
/// How long a workspace reservation lasts, as `workspaces.py` reserves it.
pub const RESERVE_FOR: &str = "24h";

#[derive(Debug)]
pub enum WorkspaceError {
    /// The root exists, holds entries and has no owned marker.
    Unowned(PathBuf),
    /// The name is not `[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}`.
    Identifier(String),
    /// The workspace path is a symlink.
    Symlink(PathBuf),
    /// Another operation holds this workspace's lock.
    Busy(String),
    Io(io::Error),
    Lease(LeaseError),
}
impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unowned(root) => {
                write!(
                    f,
                    "refusing an existing unowned workspace root: {}",
                    root.display()
                )
            }
            Self::Identifier(name) => write!(f, "invalid workspace identifier: {name:?}"),
            Self::Symlink(path) => write!(f, "workspace must not be a symlink: {}", path.display()),
            Self::Busy(name) => write!(f, "another operation holds workspace {name}"),
            Self::Io(error) => error.fmt(f),
            Self::Lease(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for WorkspaceError {}
impl From<io::Error> for WorkspaceError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<LeaseError> for WorkspaceError {
    fn from(error: LeaseError) -> Self {
        Self::Lease(error)
    }
}
pub type Result<T> = std::result::Result<T, WorkspaceError>;

/// A held operation lock on one workspace; dropping it releases the lock.
pub struct OperationLock {
    lock: Flock<File>,
}
impl OperationLock {
    /// The descriptor holding the lock, for a controller that records it.
    #[must_use]
    pub fn raw_fd(&self) -> RawFd {
        self.lock.as_raw_fd()
    }
}
impl AsFd for OperationLock {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.lock.as_fd()
    }
}

/// An owned root of task workspaces.
#[derive(Clone, Debug)]
pub struct TaskWorkspaces {
    root: PathBuf,
}
impl TaskWorkspaces {
    /// Open or create the root. An existing root that holds entries but no
    /// owned marker is refused untouched. The root and `.ops` are private.
    pub fn open(root: &Path) -> Result<Self> {
        let root = std::path::absolute(root)?;
        let marker = root.join(OWNED_MARKER);
        if !marker.exists() && root.exists() && fs::read_dir(&root)?.next().is_some() {
            return Err(WorkspaceError::Unowned(root));
        }
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)?;
        let root = root.canonicalize()?;
        OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(root.join(OWNED_MARKER))?;
        match DirBuilder::new().mode(0o700).create(root.join(".ops")) {
            Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error.into()),
            _ => {}
        }
        Ok(Self { root })
    }
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }
    /// The workspace path for `name`, which must be a plain identifier and
    /// must not name a symlink.
    pub fn path(&self, name: &str) -> Result<PathBuf> {
        if !identifier(name) {
            return Err(WorkspaceError::Identifier(name.to_owned()));
        }
        let path = self.root.join(name);
        if path.is_symlink() {
            return Err(WorkspaceError::Symlink(path));
        }
        Ok(path)
    }
    /// Take the workspace's operation lock at once, or refuse while another
    /// operation holds it. The lock file is private and never removed.
    pub fn operation(&self, name: &str) -> Result<OperationLock> {
        self.path(name)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.root.join(".ops").join(format!("{name}.lock")))?;
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => Ok(OperationLock { lock }),
            Err((_, nix::errno::Errno::EWOULDBLOCK)) => Err(WorkspaceError::Busy(name.to_owned())),
            Err((_, error)) => Err(io::Error::from(error).into()),
        }
    }
    /// Replace the workspace metadata durably: write and sync a temporary
    /// file, rename it over `.reverie-task.json`, then sync the directory.
    /// `json` is one JSON document; a newline is appended.
    pub fn write(&self, workspace: &Path, json: &[u8]) -> Result<()> {
        let temp = workspace.join(".reverie-task.json.tmp");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)?;
        file.write_all(json)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temp, workspace.join(METADATA))?;
        File::open(workspace)?.sync_all()?;
        Ok(())
    }
    /// Reserve the workspace in `base` for `RESERVE_FOR`, owned by `$USER`, or
    /// renew the reservation it already has, as `workspaces.py` does. Returns
    /// the workspace's lease key.
    pub fn reserve(&self, base: &LeaseBase, workspace: &Path, renew: bool) -> Result<String> {
        Ok(lease::reserve(
            base,
            workspace,
            RESERVE_FOR,
            "",
            None,
            Duration::from_secs(60),
            renew,
        )?)
    }
}

fn identifier(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 80
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}
