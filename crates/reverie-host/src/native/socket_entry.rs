//! Shared filesystem socket-inode custody. Callers own the actual new listener
//! before creating this private entry. Purpose modules retain their distinct
//! directory, stale-socket and native-handler policies. These metadata checks
//! require actual lifecycle writer exclusion; they are not atomic name unlink.
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::PathBuf,
};
#[derive(Debug)]
pub(crate) enum SocketError {
    Io(io::Error),
    Unconfirmed,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl From<io::Error> for SocketError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
type Result<T> = std::result::Result<T, SocketError>;
fn finalized(result: Result<()>, closed: Result<()>) -> Result<()> {
    match (result, closed) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(SocketError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
pub(crate) struct SocketEntry {
    path: PathBuf,
    identity: Option<[u64; 2]>,
    state: State,
    anchor: Option<File>,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum State {
    Active,
    Observed,
    Removed,
    Unconfirmed,
}
impl SocketEntry {
    pub(crate) fn created(path: PathBuf) -> Self {
        Self {
            path,
            identity: None,
            state: State::Active,
            anchor: None,
        }
    }
    pub(crate) fn observed(path: PathBuf) -> Self {
        Self {
            path,
            identity: None,
            state: State::Observed,
            anchor: None,
        }
    }
    pub(crate) fn open_anchor(&mut self) -> Result<()> {
        // Pin the filesystem inode itself, not the distinct kernel socket FD.
        self.anchor = Some(
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&self.path)?,
        );
        Ok(())
    }
    pub(crate) fn finish_pin(&mut self) -> Result<()> {
        self.pin_identity()?;
        let anchor = self.anchor.as_ref().ok_or(SocketError::Unconfirmed)?;
        let held_path = format!("/proc/self/fd/{}", anchor.as_raw_fd());
        fs::set_permissions(held_path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }
    pub(crate) fn pin_identity(&mut self) -> Result<()> {
        let anchor = self.anchor.as_ref().ok_or(SocketError::Unconfirmed)?;
        let metadata = anchor.metadata()?;
        self.identity = Some([metadata.dev(), metadata.ino()]);
        self.check_anchor()?;
        let named = fs::symlink_metadata(&self.path)?;
        if !named.file_type().is_socket() || Some([named.dev(), named.ino()]) != self.identity {
            return Err(SocketError::Unconfirmed);
        }
        Ok(())
    }
    pub(crate) fn remove_stale(&mut self) -> Result<()> {
        if self.state != State::Observed {
            return Err(SocketError::Unconfirmed);
        }
        self.state = State::Active;
        self.remove()
    }
    pub(crate) fn preserve_name(&mut self) -> Result<()> {
        match self.state {
            State::Removed => return Ok(()),
            State::Unconfirmed | State::Active => return Err(SocketError::Unconfirmed),
            State::Observed => (),
        }
        self.state = State::Unconfirmed;
        let result = self.anchor.take().map_or(Ok(()), |anchor| {
            crate::native::close(anchor).map_err(|_| SocketError::Unconfirmed)
        });
        if result.is_ok() {
            self.state = State::Removed;
        }
        result
    }
    pub(crate) fn remove(&mut self) -> Result<()> {
        match self.state {
            State::Removed => return Ok(()),
            State::Unconfirmed => return Err(SocketError::Unconfirmed),
            State::Observed => return Err(SocketError::Unconfirmed),
            State::Active => (),
        }
        self.state = State::Unconfirmed;
        let removed = self.remove_entry();
        let closed = self.anchor.take().map_or(Ok(()), |anchor| {
            crate::native::close(anchor).map_err(|_| SocketError::Unconfirmed)
        });
        let result = finalized(removed, closed);
        if result.is_ok() {
            self.state = State::Removed;
        }
        result
    }
    fn remove_entry(&self) -> Result<()> {
        self.check_anchor()?;
        match fs::symlink_metadata(&self.path) {
            Ok(metadata)
                if metadata.file_type().is_socket()
                    && Some([metadata.dev(), metadata.ino()]) == self.identity =>
            {
                fs::remove_file(&self.path)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err(SocketError::Unconfirmed),
            Err(error) => Err(error.into()),
        }
    }
    fn check_anchor(&self) -> Result<()> {
        let anchor = self
            .anchor
            .as_ref()
            .ok_or(SocketError::Unconfirmed)?
            .metadata()?;
        if !anchor.file_type().is_socket() || Some([anchor.dev(), anchor.ino()]) != self.identity {
            return Err(SocketError::Unconfirmed);
        }
        Ok(())
    }
}
impl Drop for SocketEntry {
    fn drop(&mut self) {
        if self.state == State::Active {
            let _ = self.remove();
        } else if self.state == State::Observed {
            let _ = self.preserve_name();
        }
    }
}

#[cfg(test)]
impl SocketEntry {
    pub(crate) fn test_path(&self) -> &std::path::Path {
        &self.path
    }
    pub(crate) fn test_identity(&self) -> Option<[u64; 2]> {
        self.identity
    }
    pub(crate) fn test_has_anchor(&self) -> bool {
        self.anchor.is_some()
    }
}
