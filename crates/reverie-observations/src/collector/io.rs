//! Bounded reads and the append-only output files of the collector.
use nix::errno::Errno;
use nix::fcntl::{OFlag, open};
use nix::sys::stat::{Mode, fstat};
use reverie_contracts::collector::{Out, RollFiles, dump, records};
use reverie_contracts::collector_state::os_error;
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};

/// Why a bounded read failed: an `OSError` with its filename, or `InputError`.
#[derive(Debug)]
pub(crate) enum ReadError {
    Os(Errno, PathBuf),
    Input(String),
}

/// Python's `OSError` subclass name for an errno.
pub(crate) fn os_class(errno: Errno) -> &'static str {
    match errno {
        Errno::ENOENT => "FileNotFoundError",
        Errno::EACCES | Errno::EPERM => "PermissionError",
        Errno::EISDIR => "IsADirectoryError",
        Errno::ENOTDIR => "NotADirectoryError",
        Errno::EEXIST => "FileExistsError",
        Errno::EINTR => "InterruptedError",
        Errno::EAGAIN | Errno::EALREADY | Errno::EINPROGRESS => "BlockingIOError",
        Errno::ECHILD => "ChildProcessError",
        Errno::ESRCH => "ProcessLookupError",
        Errno::ETIMEDOUT => "TimeoutError",
        Errno::EPIPE | Errno::ESHUTDOWN => "BrokenPipeError",
        Errno::ECONNABORTED => "ConnectionAbortedError",
        Errno::ECONNREFUSED => "ConnectionRefusedError",
        Errno::ECONNRESET => "ConnectionResetError",
        _ => "OSError",
    }
}

pub(crate) fn errno_of(error: &std::io::Error) -> Errno {
    Errno::from_raw(error.raw_os_error().unwrap_or(libc::EIO))
}

/// Python `str` code points of a host path.
pub(crate) fn points(path: &Path) -> Vec<u32> {
    reverie_core::posix_text::decode(path.as_os_str().as_bytes())
}

/// `str(OSError(errno, strerror, path))`.
pub(crate) fn os_message(errno: Errno, path: &Path) -> String {
    let text = std::io::Error::from_raw_os_error(errno as i32).to_string();
    let suffix = format!(" (os error {})", errno as i32);
    let text = text.strip_suffix(&suffix).unwrap_or(&text).to_owned();
    os_error(errno as i32, &text, Some(&points(path)))
}

impl ReadError {
    pub(crate) fn class(&self) -> &'static str {
        match self {
            Self::Os(errno, _) => os_class(*errno),
            Self::Input(_) => "InputError",
        }
    }
    /// `str(error)`.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Os(errno, path) => os_message(*errno, path),
            Self::Input(message) => message.clone(),
        }
    }
}

/// `read_small(path, limit)`: a regular file, never a final symlink, of at
/// most `limit` bytes, decoded as UTF-8 with replacement.
pub(crate) fn read_small(path: &Path, limit: i64) -> Result<String, ReadError> {
    let os = |errno| ReadError::Os(errno, path.to_path_buf());
    let fd = open(
        path,
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(os)?;
    let file = File::from(fd);
    let info = fstat(&file).map_err(os)?;
    if info.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(ReadError::Input("not a regular file".into()));
    }
    let bound = u64::try_from(limit).unwrap_or(0);
    let mut data = Vec::new();
    (&file)
        .take(bound + 1)
        .read_to_end(&mut data)
        .map_err(|error| os(errno_of(&error)))?;
    if data.len() as u64 > bound {
        return Err(ReadError::Input(format!("over {limit} bytes")));
    }
    Ok(String::from_utf8_lossy(&data).into_owned())
}

/// `append_line(path, obj)`: end a crash-truncated last line first, then
/// append one record and sync.
pub(crate) fn append_line(path: &Path, line: &str) -> Result<(), Errno> {
    let flags =
        OFlag::O_RDWR | OFlag::O_APPEND | OFlag::O_CREAT | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut file = File::from(open(path, flags, Mode::from_bits_truncate(0o644))?);
    let size = fstat(&file)?.st_size;
    if size > 0 {
        let mut last = [0u8; 1];
        let offset = u64::try_from(size - 1).unwrap_or(0);
        file.read_exact_at(&mut last, offset)
            .map_err(|error| errno_of(&error))?;
        if last != *b"\n" {
            file.write_all(b"\n").map_err(|error| errno_of(&error))?;
        }
    }
    file.write_all(format!("{line}\n").as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| errno_of(&error))
}

/// `write_state(path, state)`: a synced temporary file renamed into place,
/// then the directory synced.
pub(crate) fn write_state(path: &Path, state: &Out) -> Result<(), Errno> {
    let text = dump(state).ok_or(Errno::EINVAL)?;
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    let flags =
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_TRUNC | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut file = File::from(open(&temporary, flags, Mode::from_bits_truncate(0o644))?);
    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| errno_of(&error))?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|error| errno_of(&error))?;
    let directory = path.parent().unwrap_or(Path::new("."));
    let fd = open(
        directory,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY,
        Mode::empty(),
    )?;
    File::from(fd).sync_all().map_err(|error| errno_of(&error))
}

/// `read_lines_counted(path, cfg)`: missing is empty; unreadable counts once.
pub(crate) fn read_lines(
    path: &Path,
    limit: i64,
) -> (Vec<reverie_contracts::collector::Record>, usize) {
    match read_small(path, limit) {
        Ok(text) => records(&text),
        Err(ReadError::Os(Errno::ENOENT, _)) => (Vec::new(), 0),
        Err(_) => (Vec::new(), 1),
    }
}

/// The output directory as a roll sees it. The first failed append stops
/// every later one, as Python's exception would.
pub(crate) struct OutDir {
    pub(crate) dir: PathBuf,
    pub(crate) limit: i64,
    pub(crate) failed: Option<(Errno, PathBuf)>,
}

impl RollFiles for OutDir {
    fn records(&mut self, name: &str) -> Vec<reverie_contracts::collector::Record> {
        read_lines(&self.dir.join(name), self.limit).0
    }
    fn sample_names(&mut self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| reverie_contracts::collector::sample_name(name))
            .collect()
    }
    fn append(&mut self, name: &str, line: &str) {
        if self.failed.is_some() {
            return;
        }
        let path = self.dir.join(name);
        if let Err(errno) = append_line(&path, line) {
            self.failed = Some((errno, path));
        }
    }
}
