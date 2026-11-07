//! Owner-only Unix socket custody for the native broker listener: directory
//! and stale-socket checks, bind with the legacy backlog, peer identity and the
//! inode-guarded unlink. This is no dispatcher, engine effect or service
//! lifecycle; the broker service owns ordering, admission and shutdown.
#[cfg(test)]
mod tests;
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io,
    os::fd::AsRawFd,
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
};

/// The legacy broker's `listener.listen(8)`.
pub const BACKLOG: i32 = 8;
/// The legacy broker cuts an E frame's UTF-8 bytes here, even mid-code-point.
pub const ERROR_FRAME_BYTES: usize = 1000;
/// The fixed E text for every failure that is not a refusal.
pub const TRANSPORT_FAILED: &str = "Worker transport failed";

#[derive(Debug)]
pub enum ListenerError {
    /// The socket directory is a symlink, foreign-owned or group/other accessible.
    DirectoryUnsafe,
    /// An existing entry at the socket path is not a socket.
    NotSocket,
    /// An existing socket accepted a probe connection.
    AlreadyListening,
    /// The bound leaf could not be identified; it is fenced, never guessed.
    Unconfirmed,
    Io(io::Error),
}
impl ListenerError {
    /// The legacy refusal texts, so startup diagnostics stay comparable.
    pub fn message(&self) -> &'static str {
        match self {
            Self::DirectoryUnsafe => "Worker socket directory must be owner-only",
            Self::NotSocket => "Refusing to replace a non-socket",
            Self::AlreadyListening => "Another worker broker is already listening",
            Self::Unconfirmed => "Worker socket identity is unconfirmed",
            Self::Io(_) => TRANSPORT_FAILED,
        }
    }
}
impl From<io::Error> for ListenerError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
pub type Result<T> = std::result::Result<T, ListenerError>;

/// `mkdir 0700` (with parents), then refuse a symlinked, foreign-owned or
/// group/other-accessible parent of `socket`, as the legacy `serve()` does.
pub fn prepare_directory(socket: &Path, uid: u32) -> Result<()> {
    let parent = socket.parent().ok_or(ListenerError::DirectoryUnsafe)?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)?;
    let metadata = fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
    {
        return Err(ListenerError::DirectoryUnsafe);
    }
    Ok(())
}

/// A leftover entry is removed only when it is a socket that refuses a probe
/// connection. A live socket or a non-socket is refused and left untouched.
pub fn clear_stale(socket: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(socket) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_socket() {
        return Err(ListenerError::NotSocket);
    }
    match UnixStream::connect(socket) {
        Ok(_) => Err(ListenerError::AlreadyListening),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            fs::remove_file(socket)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

/// The bound listener plus the inode it created. Removal compares the named
/// leaf with that inode; the comparison is not an atomic unlink, so the
/// owner-only directory must exclude competing writers.
pub struct BoundSocket {
    listener: Option<UnixListener>,
    path: PathBuf,
    identity: [u64; 2],
    anchor: File,
}
impl BoundSocket {
    pub fn bind(path: &Path) -> Result<Self> {
        let listener = UnixListener::bind(path)?;
        // Pin the created inode before any further fallible step, so a later
        // failure removes only the leaf this bind made.
        let anchor = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
        {
            Ok(anchor) => anchor,
            Err(_) => return Err(ListenerError::Unconfirmed),
        };
        let held = anchor.metadata()?;
        let mut bound = Self {
            listener: Some(listener),
            path: path.to_owned(),
            identity: [held.dev(), held.ino()],
            anchor,
        };
        if let Err(error) = bound.configure() {
            let _ = bound.remove();
            return Err(error);
        }
        Ok(bound)
    }
    fn configure(&self) -> Result<()> {
        let named = fs::symlink_metadata(&self.path)?;
        if !named.file_type().is_socket() || [named.dev(), named.ino()] != self.identity {
            return Err(ListenerError::Unconfirmed);
        }
        let held = format!("/proc/self/fd/{}", self.anchor.as_raw_fd());
        fs::set_permissions(held, fs::Permissions::from_mode(0o600))?;
        let listener = self.listener()?;
        // The std bind listens with its own backlog; listening again on Linux
        // only replaces the backlog with the legacy value.
        let backlog =
            nix::sys::socket::Backlog::new(BACKLOG).map_err(|_| ListenerError::Unconfirmed)?;
        nix::sys::socket::listen(listener, backlog).map_err(io::Error::from)?;
        Ok(())
    }
    pub fn listener(&self) -> Result<&UnixListener> {
        self.listener.as_ref().ok_or(ListenerError::Unconfirmed)
    }
    pub fn identity(&self) -> [u64; 2] {
        self.identity
    }
    /// Close the listener, then unlink the path only if it still names the
    /// bound inode. A replaced or missing leaf is left alone.
    pub fn remove(&mut self) -> Result<bool> {
        drop(self.listener.take());
        match fs::symlink_metadata(&self.path) {
            Ok(metadata)
                if metadata.file_type().is_socket()
                    && [metadata.dev(), metadata.ino()] == self.identity =>
            {
                fs::remove_file(&self.path)?;
                Ok(true)
            }
            Ok(_) => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

/// The kernel peer UID, read before any frame.
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let credentials =
        nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
            .map_err(io::Error::from)?;
    Ok(credentials.uid())
}

/// The legacy E payload: the message's UTF-8 bytes, cut at 1000 bytes.
pub fn error_payload(message: &str) -> Vec<u8> {
    let bytes = message.as_bytes();
    bytes[..bytes.len().min(ERROR_FRAME_BYTES)].to_vec()
}
