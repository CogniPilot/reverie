//! Socket custody is local filesystem ownership, never request authorization.
//! The lifecycle owner must exclude competing writers to its private directory;
//! an inode comparison is deliberately not called an atomic unlink operation.
use super::{OfficeError, Result};
use std::{
    fs::{self, DirBuilder},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt},
        net::UnixListener,
    },
    path::{Component, Path},
};
#[cfg(test)]
mod tests;
pub(super) use crate::native::socket_entry::SocketEntry;
pub(super) fn bind(directory: &Path) -> Result<(UnixListener, SocketEntry)> {
    prepare_directory(directory)?;
    let path = directory.join("office.sock");
    // Never unlink an existing phone, including a live/replaced socket.
    let listener = UnixListener::bind(&path)?;
    // Adopt the created leaf before the first fallible metadata/anchor read.
    // An unidentified leaf is fenced, never guessed to belong to this socket.
    let mut entry = SocketEntry::created(path);
    if let Err(error) = configure(&mut entry, &listener) {
        let closed = super::server::close_listener(listener);
        return super::finalized(
            Err(error),
            super::finalized(closed, entry.remove().map_err(socket_error)),
        );
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
fn configure(entry: &mut SocketEntry, listener: &UnixListener) -> Result<()> {
    #[cfg(test)]
    super::test_hooks::fail(super::test_hooks::Failure::BeforeAnchor)?;
    entry.open_anchor().map_err(socket_error)?;
    #[cfg(test)]
    super::test_hooks::fail(super::test_hooks::Failure::AfterAnchor)?;
    entry.finish_pin().map_err(socket_error)?;
    listener.set_nonblocking(true)?;
    Ok(())
}
pub(super) fn socket_error(error: crate::native::socket_entry::SocketError) -> OfficeError {
    match error {
        crate::native::socket_entry::SocketError::Io(error) => OfficeError::Io(error),
        crate::native::socket_entry::SocketError::Unconfirmed => OfficeError::Unconfirmed,
        crate::native::socket_entry::SocketError::Finalization { primary, secondary } => {
            OfficeError::Finalization {
                primary: Box::new(socket_error(*primary)),
                secondary: Box::new(socket_error(*secondary)),
            }
        }
    }
}
