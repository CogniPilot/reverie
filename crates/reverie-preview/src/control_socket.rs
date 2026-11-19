use crate::invalid;
use nix::fcntl::{Flock, FlockArg};
use std::{
    ffi::OsString,
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io::{self, ErrorKind},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixListener,
    },
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{net::UnixStream, time::timeout};

pub(crate) struct ControlSocket {
    pub(crate) listener: tokio::net::UnixListener,
    path: PathBuf,
    identity: (u64, u64),
    _lock: Flock<File>,
}

impl ControlSocket {
    pub(crate) async fn bind(path: &Path) -> io::Result<Self> {
        let parent = path
            .parent()
            .ok_or_else(|| invalid("control socket needs a parent"))?;
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        let directory = fs::symlink_metadata(parent)?;
        if !directory.is_dir() || !private(&directory) {
            return Err(invalid(
                "control socket requires an owner-only private directory",
            ));
        }
        let lock = lock(path)?;
        reclaim(path).await?;
        let socket = UnixListener::bind(path)?;
        let identity = identity(&fs::symlink_metadata(path)?);
        let opened = (|| {
            socket.set_nonblocking(true)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            let listener = tokio::net::UnixListener::from_std(socket)?;
            Ok(Self {
                listener,
                path: path.to_owned(),
                identity,
                _lock: lock,
            })
        })();
        if opened.is_err() {
            unlink_exact(path, identity);
        }
        opened
    }
}

impl Drop for ControlSocket {
    fn drop(&mut self) {
        unlink_exact(&self.path, self.identity);
    }
}

fn private(metadata: &Metadata) -> bool {
    metadata.uid() == nix::unistd::geteuid().as_raw() && metadata.mode() & 0o077 == 0
}

fn lock(path: &Path) -> io::Result<Flock<File>> {
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(".lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(name)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || !private(&metadata) {
        return Err(invalid("preview control lock is not private"));
    }
    Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|(_, error)| error.into())
}

async fn reclaim(path: &Path) -> io::Result<()> {
    let existing = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !existing.file_type().is_socket() || existing.uid() != nix::unistd::geteuid().as_raw() {
        return Err(invalid("unexpected preview control socket path"));
    }
    match timeout(Duration::from_secs(1), UnixStream::connect(path)).await? {
        Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
            let current = fs::symlink_metadata(path)?;
            if !current.file_type().is_socket() || identity(&current) != identity(&existing) {
                return Err(invalid("preview control socket was replaced"));
            }
            fs::remove_file(path)
        }
        _ => Err(io::Error::new(
            ErrorKind::AddrInUse,
            "preview control socket in use",
        )),
    }
}

fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

fn unlink_exact(path: &Path, expected: (u64, u64)) {
    if fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_socket() && identity(&metadata) == expected)
    {
        let _ = fs::remove_file(path);
    }
}
