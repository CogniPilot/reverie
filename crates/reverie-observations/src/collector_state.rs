//! `cleanup/collector_state.py prepare()`: create or re-check a private,
//! marked collector state directory without adopting another application's
//! data. Existing directories are never chmodded or chowned.
use nix::errno::Errno;
use nix::fcntl::{OFlag, open};
use nix::sys::stat::{Mode, fstat, lstat, stat};
use reverie_contracts::collector_state::{
    FOREIGN_STATE, INVALID_MARKER, MARKER, NOT_PRIVATE, UNSAFE_ANCESTRY, ancestry,
    dedicated_state_path, marker_path, os_error,
};
use std::ffi::OsString;
use std::fs::{DirBuilder, File};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;

/// A `ValueError` (refusal) or an `OSError` with its filename, if any.
#[derive(Debug, Eq, PartialEq)]
pub enum StateError {
    Refused(&'static str),
    Os(Errno, Option<Vec<u32>>),
}

impl StateError {
    /// `str(error)`.
    pub fn message(&self) -> String {
        match self {
            Self::Refused(why) => (*why).to_owned(),
            Self::Os(errno, name) => os_error(*errno as i32, &strerror(*errno), name.as_deref()),
        }
    }
}

/// The C library `strerror` text Python reports (std formats it as
/// `<text> (os error N)`).
fn strerror(errno: Errno) -> String {
    let text = std::io::Error::from_raw_os_error(errno as i32).to_string();
    let suffix = format!(" (os error {})", errno as i32);
    text.strip_suffix(&suffix)
        .map_or(text.clone(), str::to_owned)
}

fn host(points: &[u32]) -> PathBuf {
    // Points decoded from argv bytes always re-encode (surrogateescape).
    let bytes = reverie_core::posix_text::encode(points).unwrap_or_default();
    PathBuf::from(OsString::from_vec(bytes))
}

fn os(name: &[u32]) -> impl Fn(Errno) -> StateError + '_ {
    move |errno| StateError::Os(errno, Some(name.to_vec()))
}

fn io(error: &std::io::Error) -> Errno {
    Errno::from_raw(error.raw_os_error().unwrap_or(libc::EIO))
}

fn is_directory(mode: u32) -> bool {
    mode & libc::S_IFMT == libc::S_IFDIR
}

/// The marker already present: a private regular file with one link, owned
/// by an owner, holding exactly `MARKER`.
fn check_marker(marker: &[u32], owners: &[u32]) -> Result<(), StateError> {
    let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
    let file = File::from(open(&host(marker), flags, Mode::empty()).map_err(os(marker))?);
    let info = fstat(&file).map_err(|errno| StateError::Os(errno, None))?;
    if info.st_mode & libc::S_IFMT != libc::S_IFREG
        || !owners.contains(&info.st_uid)
        || info.st_nlink != 1
        || info.st_mode & 0o077 != 0
    {
        return Err(StateError::Refused(INVALID_MARKER));
    }
    let mut data = Vec::new();
    (&file)
        .take(MARKER.len() as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|error| StateError::Os(io(&error), None))?;
    if data != MARKER {
        return Err(StateError::Refused(INVALID_MARKER));
    }
    Ok(())
}

/// A new marker in an empty directory, written and synced.
fn create_marker(path: &[u32], marker: &[u32]) -> Result<(), StateError> {
    let mut entries = std::fs::read_dir(host(path))
        .map_err(|error| StateError::Os(io(&error), Some(path.to_vec())))?;
    if entries.next().is_some() {
        return Err(StateError::Refused(FOREIGN_STATE));
    }
    let flags =
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let fd = open(&host(marker), flags, Mode::from_bits_truncate(0o600)).map_err(os(marker))?;
    let mut file = File::from(fd);
    file.write_all(MARKER)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|error| StateError::Os(io(&error), None))
}

/// `prepare(value)` for an administrator whose files belong to one of
/// `owners` (only root on a host). Returns `str(Path(value))`.
pub fn prepare(value: &[u32], owners: &[u32]) -> Result<Vec<u32>, StateError> {
    let path = dedicated_state_path(value).map_err(StateError::Refused)?;
    for parent in ancestry(&path) {
        let name = host(&parent);
        let symlink = std::fs::symlink_metadata(&name).is_ok_and(|meta| meta.is_symlink());
        if std::fs::metadata(&name).is_err() && !symlink {
            DirBuilder::new()
                .mode(0o700)
                .create(&name)
                .map_err(|error| StateError::Os(io(&error), Some(parent.clone())))?;
        }
        let info = lstat(&name).map_err(os(&parent))?;
        if !is_directory(info.st_mode)
            || !owners.contains(&info.st_uid)
            || info.st_mode & 0o022 != 0
        {
            return Err(StateError::Refused(UNSAFE_ANCESTRY));
        }
    }
    if stat(&host(&path)).map_err(os(&path))?.st_mode & 0o077 != 0 {
        return Err(StateError::Refused(NOT_PRIVATE));
    }
    let marker = marker_path(&path);
    let name = host(&marker);
    let present = std::fs::metadata(&name).is_ok()
        || std::fs::symlink_metadata(&name).is_ok_and(|meta| meta.is_symlink());
    if present {
        check_marker(&marker, owners)?;
    } else {
        create_marker(&path, &marker)?;
    }
    Ok(path)
}
