//! Socket custody is local filesystem ownership, never request authorization.
//! The lifecycle owner must exclude competing writers to its private directory;
//! an inode comparison is deliberately not called an atomic unlink operation.
use super::{OfficeError, Result};
use std::{
    fs::{self, DirBuilder},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
        net::UnixListener,
    },
    path::{Component, Path, PathBuf},
};
pub(super) struct SocketEntry {
    path: PathBuf,
    identity: [u64; 2],
    state: State,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum State {
    Active,
    Removed,
    Unconfirmed,
}
pub(super) fn bind(directory: &Path) -> Result<(UnixListener, SocketEntry)> {
    if !directory.is_absolute()
        || directory
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(OfficeError::Refused);
    }
    // Check the nearest existing ancestor before recursive creation. Every
    // ancestor is rechecked before bind; no symlink is accepted as a directory.
    for ancestor in directory.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() => (),
            Ok(_) => return Err(OfficeError::Refused),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    for ancestor in directory.ancestors() {
        if !fs::symlink_metadata(ancestor)?.is_dir() {
            return Err(OfficeError::Refused);
        }
    }
    let metadata = fs::symlink_metadata(directory)?;
    if metadata.uid() != crate::native::uid() || metadata.mode() & 0o077 != 0 {
        return Err(OfficeError::Refused);
    }
    let path = directory.join("office.sock");
    // Never unlink an existing phone, including a live/replaced socket.
    // Stale-socket recovery requires the canonical recovery owner.
    let listener = UnixListener::bind(&path)?;
    let metadata = fs::symlink_metadata(&path)?;
    let mut entry = SocketEntry {
        path,
        identity: [metadata.dev(), metadata.ino()],
        state: State::Active,
    };
    let configured = fs::set_permissions(&entry.path, fs::Permissions::from_mode(0o600))
        .and_then(|()| listener.set_nonblocking(true));
    if let Err(error) = configured {
        return super::finalized(Err(error.into()), entry.remove());
    }
    Ok((listener, entry))
}
impl SocketEntry {
    pub(super) fn remove(&mut self) -> Result<()> {
        match self.state {
            State::Removed => return Ok(()),
            State::Unconfirmed => return Err(OfficeError::Unconfirmed),
            State::Active => (),
        }
        self.state = State::Unconfirmed;
        match fs::symlink_metadata(&self.path) {
            Ok(metadata)
                if metadata.file_type().is_socket()
                    && [metadata.dev(), metadata.ino()] == self.identity =>
            {
                fs::remove_file(&self.path)?;
                self.state = State::Removed;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.state = State::Removed;
                Ok(())
            }
            Ok(_) => Err(OfficeError::Unconfirmed),
            Err(error) => Err(error.into()),
        }
    }
}
impl Drop for SocketEntry {
    fn drop(&mut self) {
        if self.state == State::Active {
            let _ = self.remove();
        }
    }
}
