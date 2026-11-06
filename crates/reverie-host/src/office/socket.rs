//! Socket custody is local filesystem ownership, never request authorization.
//! The lifecycle owner must exclude competing writers to its private directory;
//! an inode comparison is deliberately not called an atomic unlink operation.
use super::{OfficeError, Result};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    os::fd::AsRawFd,
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixListener,
    },
    path::{Component, Path, PathBuf},
};
#[cfg(test)]
mod tests;
pub(super) struct SocketEntry {
    path: PathBuf,
    identity: Option<[u64; 2]>,
    state: State,
    anchor: Option<File>,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum State {
    Active,
    Removed,
    Unconfirmed,
}
pub(super) fn bind(directory: &Path) -> Result<(UnixListener, SocketEntry)> {
    prepare_directory(directory)?;
    let path = directory.join("office.sock");
    // Never unlink an existing phone, including a live/replaced socket.
    let listener = UnixListener::bind(&path)?;
    // Adopt the created leaf before the first fallible metadata/anchor read.
    // An unidentified leaf is fenced, never guessed to belong to this socket.
    let mut entry = SocketEntry {
        path,
        identity: None,
        state: State::Active,
        anchor: None,
    };
    if let Err(error) = entry.configure(&listener) {
        let closed = super::server::close_listener(listener);
        return super::finalized(Err(error), super::finalized(closed, entry.remove()));
    }
    Ok((listener, entry))
}
fn prepare_directory(directory: &Path) -> Result<()> {
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
    Ok(())
}
impl SocketEntry {
    fn configure(&mut self, listener: &UnixListener) -> Result<()> {
        #[cfg(test)]
        super::test_hooks::fail(super::test_hooks::Failure::BeforeAnchor)?;
        // Pin the filesystem inode itself, not the distinct kernel socket FD.
        self.anchor = Some(
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&self.path)?,
        );
        #[cfg(test)]
        super::test_hooks::fail(super::test_hooks::Failure::AfterAnchor)?;
        let anchor = self.anchor.as_ref().ok_or(OfficeError::Unconfirmed)?;
        let metadata = anchor.metadata()?;
        self.identity = Some([metadata.dev(), metadata.ino()]);
        self.check_anchor()?;
        let named = fs::symlink_metadata(&self.path)?;
        if !named.file_type().is_socket() || Some([named.dev(), named.ino()]) != self.identity {
            return Err(OfficeError::Unconfirmed);
        }
        let held_path = format!("/proc/self/fd/{}", anchor.as_raw_fd());
        fs::set_permissions(held_path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(())
    }
    pub(super) fn remove(&mut self) -> Result<()> {
        match self.state {
            State::Removed => return Ok(()),
            State::Unconfirmed => return Err(OfficeError::Unconfirmed),
            State::Active => (),
        }
        self.state = State::Unconfirmed;
        let removed = self.remove_entry();
        let closed = self.anchor.take().map_or(Ok(()), |anchor| {
            crate::native::close(anchor).map_err(|_| OfficeError::Unconfirmed)
        });
        let result = super::finalized(removed, closed);
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
            Ok(_) => Err(OfficeError::Unconfirmed),
            Err(error) => Err(error.into()),
        }
    }
    fn check_anchor(&self) -> Result<()> {
        let anchor = self
            .anchor
            .as_ref()
            .ok_or(OfficeError::Unconfirmed)?
            .metadata()?;
        if !anchor.file_type().is_socket() || Some([anchor.dev(), anchor.ino()]) != self.identity {
            return Err(OfficeError::Unconfirmed);
        }
        Ok(())
    }
}
impl Drop for SocketEntry {
    fn drop(&mut self) {
        if self.state == State::Active {
            let _ = self.remove();
        }
    }
}
