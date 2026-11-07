//! Local owner bootstrap over the existing registered deployment and lock.
use super::*;
use nix::unistd::geteuid;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(super) struct Installation {
    pub(super) root: PathBuf,
    pub(super) name: String,
    pub(super) port: u16,
    pub(super) revision: String,
    pub(super) state: PathBuf,
    lock: Option<File>,
    lock_identity: (u64, u64),
    parent: Option<File>,
    parent_identity: (u64, u64),
    config_identity: (u64, u64),
}
impl Installation {
    pub(super) fn capture(root: &Path) -> Result<Self> {
        let root = root.canonicalize()?;
        private(&root, true)?;
        let config = root.join("deployment.json");
        private(&config, false)?;
        let config_metadata = std::fs::symlink_metadata(&config)?;
        let raw = read_bounded(&config, 64 * 1024)?;
        let value: Value = serde_json::from_slice(&raw)?;
        require(
            value["version"] == 1 && value["protectedWebsite"] != true,
            "DEPLOYMENT_PROFILE_UNSUPPORTED",
        )?;
        require(
            matches!(value["websiteRuntime"].as_str(), None | Some("default")),
            "DEPLOYMENT_PROFILE_UNSUPPORTED",
        )?;
        let name = value["containerName"]
            .as_str()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_NAME_REQUIRED"))?
            .to_owned();
        require(valid_name(&name), "DEPLOYMENT_NAME_INVALID")?;
        let port = value["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p != 0)
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_PORT_INVALID"))?;
        let state = root.join("runtime/update-state");
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&state)?;
        private(&state, true)?;
        let mut installation = Self {
            root,
            name,
            port,
            revision: digest(&raw),
            state,
            lock: None,
            lock_identity: (0, 0),
            parent: None,
            parent_identity: (0, 0),
            config_identity: (config_metadata.dev(), config_metadata.ino()),
        };
        match installation.acquire() {
            Ok(()) => Ok(installation),
            Err(error) => DeploymentError::finalized(Err(error), installation.close()),
        }
    }
    fn acquire(&mut self) -> Result<()> {
        self.parent = Some(
            OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
                .open(&self.state)?,
        );
        let pm = self.parent.as_ref().expect("adopted parent").metadata()?;
        self.parent_identity = (pm.dev(), pm.ino());
        let lock_path = self.state.join("update.lock");
        self.lock = Some(
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
                .open(&lock_path)?,
        );
        let lock = self.lock.as_ref().expect("adopted lock");
        let m = lock.metadata()?;
        self.lock_identity = (m.dev(), m.ino());
        require(
            m.uid() == geteuid().as_raw()
                && m.is_file()
                && m.nlink() == 1
                && m.mode() & 0o077 == 0
                && m.len() == 0,
            "DEPLOYMENT_LOCK_OWNER",
        )?;
        lock.try_lock()
            .map_err(|_| DeploymentError::new("DEPLOYMENT_BUSY"))?;
        self.current()
    }
    pub(super) fn current(&self) -> Result<()> {
        let held = self
            .lock
            .as_ref()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_CLOSED"))?
            .metadata()?;
        let named = std::fs::symlink_metadata(self.state.join("update.lock"))?;
        require(
            (held.dev(), held.ino()) == self.lock_identity
                && (named.dev(), named.ino()) == self.lock_identity
                && named.nlink() == 1
                && named.mode() & 0o077 == 0
                && named.len() == 0,
            "DEPLOYMENT_LOCK_CHANGED",
        )?;
        private(&self.state, true)?;
        let parent = self
            .parent
            .as_ref()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_CLOSED"))?
            .metadata()?;
        let named_parent = std::fs::symlink_metadata(&self.state)?;
        require(
            (parent.dev(), parent.ino()) == self.parent_identity
                && (named_parent.dev(), named_parent.ino()) == self.parent_identity,
            "DEPLOYMENT_PARENT_CHANGED",
        )?;
        let config = self.root.join("deployment.json");
        private(&config, false)?;
        let cm = std::fs::symlink_metadata(&config)?;
        require(
            (cm.dev(), cm.ino()) == self.config_identity,
            "DEPLOYMENT_SELECTION_CHANGED",
        )?;
        let raw = read_bounded(&self.root.join("deployment.json"), 64 * 1024)?;
        require(
            digest(&raw) == self.revision,
            "DEPLOYMENT_SELECTION_CHANGED",
        )
    }
    pub(super) fn close(&mut self) -> Result<()> {
        let mut result = Ok(());
        if let Some(file) = self.lock.take() {
            result = nix::unistd::close(file)
                .map_err(|_| DeploymentError::new("DEPLOYMENT_LOCK_CLOSE_UNCONFIRMED"));
        }
        let parent = self
            .parent
            .take()
            .map(|file| close(file, "DEPLOYMENT_PARENT_CLOSE_UNCONFIRMED"))
            .unwrap_or(Ok(()));
        DeploymentError::finalized(result, parent)
    }
}
pub(super) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}
pub(super) fn private(path: &Path, directory: bool) -> Result<()> {
    let m = std::fs::symlink_metadata(path)?;
    require(
        !m.file_type().is_symlink()
            && m.uid() == geteuid().as_raw()
            && m.mode() & 0o077 == 0
            && (if directory { m.is_dir() } else { m.is_file() }),
        "DEPLOYMENT_PRIVATE_OWNER_REQUIRED",
    )
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let result = (|| {
        require(
            file.metadata()?.is_file(),
            "DEPLOYMENT_REGULAR_FILE_REQUIRED",
        )?;
        let mut raw = Vec::new();
        (&mut file)
            .take(maximum.saturating_add(1))
            .read_to_end(&mut raw)?;
        require(raw.len() as u64 <= maximum, "DEPLOYMENT_FILE_LIMIT")?;
        Ok(raw)
    })();
    DeploymentError::finalized(result, close(file, "DEPLOYMENT_READ_CLOSE_UNCONFIRMED"))
}
pub(super) fn exclusive_json(path: &Path, value: &Value) -> Result<()> {
    let raw = serde_json::to_vec(value)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)?;
    let written = (|| {
        file.write_all(&raw)?;
        file.sync_all()?;
        Ok(())
    })();
    let written =
        DeploymentError::finalized(written, close(file, "DEPLOYMENT_WRITE_CLOSE_UNCONFIRMED"));
    let parent = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
        .open(
            path.parent()
                .ok_or_else(|| DeploymentError::new("DEPLOYMENT_PARENT"))?,
        );
    let synced = match parent {
        Ok(file) => {
            let synced = file.sync_all().map_err(Into::into);
            DeploymentError::finalized(
                synced,
                close(file, "DEPLOYMENT_DIRECTORY_CLOSE_UNCONFIRMED"),
            )
        }
        Err(error) => Err(error.into()),
    };
    DeploymentError::finalized(written, synced)
}
fn close(file: File, code: &'static str) -> Result<()> {
    nix::unistd::close(file).map_err(|_| DeploymentError::new(code))
}
