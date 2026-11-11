//! One viewer endpoint's lifetime exclusion. This owns no worker lifecycle lock.
use super::*;
use crate::native::{self, PrivateFileStamp, private_goal};
use nix::{
    fcntl::{Flock, FlockArg},
    sys::socket::{self, AddressFamily, SockFlag, SockType, UnixAddr},
};
use reverie_contracts::worker_schema::{WorkerEnvelope, WorkerPath};
use std::{
    ffi::OsString,
    fs::{self, File},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt},
    },
};

pub(super) struct Ownership {
    path: PathBuf,
    parent: Option<File>,
    parent_identity: Option<private_goal::PathIdentity>,
    lock_name: OsString,
    opening_lock: Option<File>,
    lock: Option<Flock<File>>,
    lock_stamp: Option<PrivateFileStamp>,
}

impl Ownership {
    pub(super) fn acquire(configuration: &EffectiveWorkerConfig, path: &Path) -> Result<Self> {
        let envelope = WorkerEnvelope::capture(configuration.clone())
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_CONFIGURATION", cause))?;
        let broker = native::python_path(envelope.path(WorkerPath::Socket).codepoints())?;
        Self::acquire_at(path, &broker)
    }

    fn acquire_at(path: &Path, broker: &Path) -> Result<Self> {
        let selected = native::resolve_future_text(&native::python_text(path))?;
        let original = native::resolve_future_text(&native::python_text(broker))?;
        if selected == original {
            return Err(ViewerError::refused("WORKER_VIEWER_BROKER_SOCKET_CONFLICT"));
        }
        UnixAddr::new(path).map_err(io::Error::from)?;
        reverie_store::storage_identity::canonical(path)
            .map_err(|_| ViewerError::refused("WORKER_VIEWER_SOCKET_CUSTODY"))?;
        broker_listener::prepare_directory(path).map_err(listener_error)?;
        let mut lock_name = path
            .file_name()
            .ok_or_else(|| ViewerError::refused("WORKER_VIEWER_SOCKET_CUSTODY"))?
            .to_owned();
        lock_name.push(".lock");
        let mut owner = Self {
            path: path.to_owned(),
            parent: None,
            parent_identity: None,
            lock_name,
            opening_lock: None,
            lock: None,
            lock_stamp: None,
        };
        match owner.open() {
            Ok(()) => Ok(owner),
            Err(primary) => finalized(Err(primary), owner.close_components()),
        }
    }

    fn open(&mut self) -> Result<()> {
        let parent = self.path.parent().expect("checked socket parent");
        self.parent = Some(native::open_at(
            libc::AT_FDCWD,
            parent.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NONBLOCK,
        )?);
        let directory = self.parent.as_ref().expect("retained parent");
        self.parent_identity = Some(private_goal::identity(&directory.metadata()?));
        self.opening_lock = Some(native::open_at_mode(
            directory.as_raw_fd(),
            &self.lock_name,
            libc::O_RDWR | libc::O_CREAT | libc::O_NONBLOCK,
            0o600,
        )?);
        let file = self
            .opening_lock
            .as_ref()
            .expect("retained lock constructor");
        let info = file.metadata()?;
        if !PrivateFileStamp::of(&info).private(native::uid()) || info.len() != 0 {
            return Err(ViewerError::refused("WORKER_VIEWER_SOCKET_LOCK_CUSTODY"));
        }
        let file = self.opening_lock.take().expect("same lock constructor");
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => self.lock = Some(lock),
            Err((file, cause)) => {
                self.opening_lock = Some(file);
                return Err(if cause == nix::errno::Errno::EWOULDBLOCK {
                    ViewerError::refused("WORKER_VIEWER_SOCKET_BUSY")
                } else {
                    ViewerError::from(io::Error::from(cause))
                });
            }
        }
        self.lock_stamp = Some(PrivateFileStamp::of(
            &self.lock.as_ref().expect("held lifetime lock").metadata()?,
        ));
        self.assert_current()
    }

    fn assert_current(&self) -> Result<()> {
        let directory = self.parent.as_ref().expect("retained parent");
        let named = fs::symlink_metadata(self.path.parent().expect("checked parent"))?;
        let held = directory.metadata()?;
        let lock = self
            .lock
            .as_ref()
            .ok_or_else(|| ViewerError::refused("WORKER_VIEWER_SOCKET_LOCK_REQUIRED"))?;
        if !named.is_dir()
            || named.uid() != native::uid()
            || named.mode() & 0o7777 != 0o700
            || Some(private_goal::identity(&named)) != self.parent_identity
            || private_goal::identity(&named) != private_goal::identity(&held)
            || self.lock_stamp.as_ref() != Some(&PrivateFileStamp::of(&lock.metadata()?))
            || self.lock_stamp.as_ref()
                != Some(&PrivateFileStamp::named(directory, &self.lock_name)?)
        {
            return Err(ViewerError::refused("WORKER_VIEWER_SOCKET_LOCK_CHANGED"));
        }
        Ok(())
    }

    pub(super) fn clear_stale(&self) -> Result<()> {
        self.assert_current()?;
        let info = match fs::symlink_metadata(&self.path) {
            Ok(info) => info,
            Err(cause) if cause.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(cause) => return Err(cause.into()),
        };
        if !info.file_type().is_socket()
            || info.uid() != native::uid()
            || info.mode() & 0o7777 != 0o600
            || info.nlink() != 1
        {
            return Err(ViewerError::refused("WORKER_VIEWER_SOCKET_CUSTODY"));
        }
        let mut entry = native::socket_entry::SocketEntry::observed(self.path.clone());
        let body = entry
            .open_anchor()
            .and_then(|()| entry.pin_identity())
            .map_err(entry_error)
            .and_then(|()| self.remove_stale(&info, &mut entry));
        finalized(body, entry.preserve_name().map_err(entry_error))
    }

    fn remove_stale(
        &self,
        info: &fs::Metadata,
        entry: &mut native::socket_entry::SocketEntry,
    ) -> Result<()> {
        if entry.observation().1 != Some([info.dev(), info.ino()]) {
            return Err(ViewerError::refused("WORKER_VIEWER_SOCKET_CUSTODY"));
        }
        let current = PrivateFileStamp::named(
            self.parent.as_ref().expect("held parent"),
            self.path.file_name().expect("checked socket leaf"),
        )?;
        if current != PrivateFileStamp::of(info) {
            return Err(ViewerError::refused("WORKER_VIEWER_SOCKET_CUSTODY"));
        }
        probe_stale(&self.path)?;
        self.assert_current()?;
        entry.remove_stale().map_err(entry_error)
    }

    pub(super) fn finish(mut self) -> Result<()> {
        finalized(self.assert_current(), self.close_components())
    }

    fn close_components(&mut self) -> Result<()> {
        let lock = self.lock.take().map_or(Ok(()), |lock| match lock.unlock() {
            Ok(file) => close_file(file),
            Err((lock, cause)) => {
                std::mem::forget(lock);
                Err(ViewerError::caused(
                    "WORKER_VIEWER_SOCKET_UNLOCK",
                    io::Error::from(cause),
                ))
            }
        });
        let opening = self.opening_lock.take().map_or(Ok(()), close_file);
        let parent = self.parent.take().map_or(Ok(()), close_file);
        finalized(lock, finalized(opening, parent))
    }
}

impl Drop for Ownership {
    fn drop(&mut self) {
        std::mem::forget((
            self.lock.take(),
            self.opening_lock.take(),
            self.parent.take(),
        ));
    }
}

fn probe_stale(path: &Path) -> Result<()> {
    let address = UnixAddr::new(path).map_err(io::Error::from)?;
    let fd = socket::socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_CLOEXEC | SockFlag::SOCK_NONBLOCK,
        None,
    )
    .map_err(io::Error::from)?;
    let result = match socket::connect(fd.as_raw_fd(), &address) {
        Err(nix::errno::Errno::ECONNREFUSED) => Ok(()),
        Ok(())
        | Err(
            nix::errno::Errno::EAGAIN
            | nix::errno::Errno::EINPROGRESS
            | nix::errno::Errno::EALREADY,
        ) => Err(ViewerError::refused("WORKER_VIEWER_ALREADY_LISTENING")),
        Err(cause) => Err(io::Error::from(cause).into()),
    };
    finalized(result, close_file(File::from(fd)))
}

fn close_file(file: File) -> Result<()> {
    native::close(file).map_err(|cause| ViewerError::caused("WORKER_VIEWER_SOCKET_CLOSE", cause))
}

fn entry_error(cause: native::socket_entry::SocketError) -> ViewerError {
    use native::socket_entry::SocketError;
    match cause {
        SocketError::Io(cause) => ViewerError::caused("WORKER_VIEWER_SOCKET_CUSTODY", cause),
        SocketError::Unconfirmed => ViewerError::refused("WORKER_VIEWER_SOCKET_CUSTODY"),
        SocketError::Finalization { primary, secondary } => {
            finalized::<()>(Err(entry_error(*primary)), Err(entry_error(*secondary)))
                .expect_err("two original socket failures")
        }
    }
}

pub(super) fn finalized<T>(body: Result<T>, closed: Result<()>) -> Result<T> {
    match (body, closed) {
        (result, Ok(())) => result,
        (Ok(_), Err(cause)) => Err(cause),
        (Err(primary), Err(cleanup)) => Err(ViewerError {
            code: primary.code,
            retained: primary.retained || cleanup.retained,
            cause: Some(Box::new(primary)),
            secondary: Some(Box::new(cleanup)),
        }),
    }
}

#[cfg(test)]
mod tests;
