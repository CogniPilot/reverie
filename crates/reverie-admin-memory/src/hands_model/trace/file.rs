use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg, OFlag, openat},
    sys::stat::Mode,
    unistd::getuid,
};
use serde_json::json;
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::{self, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

pub(super) const TRACE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const EVENT_CHARS: usize = 4096;

pub(super) struct TracePath {
    parent: PathBuf,
    leaf: OsString,
}

impl TracePath {
    pub(super) fn new(path: &Path) -> io::Result<Self> {
        let parent = path.parent().ok_or_else(crate::refused)?;
        let leaf = path.file_name().ok_or_else(crate::refused)?.to_owned();
        if !path.is_absolute() {
            return Err(crate::refused());
        }
        Ok(Self {
            parent: parent.to_owned(),
            leaf,
        })
    }

    fn anchor(self) -> io::Result<TraceLocation> {
        Ok(TraceLocation {
            directory: crate::private_directory::open_private_directory(&self.parent)?,
            leaf: self.leaf,
        })
    }

    pub(super) fn read(&self) -> io::Result<Option<File>> {
        let opened = crate::private_directory::open_private_directory(&self.parent)
            .and_then(|directory| open_trace(&directory, &self.leaf, OFlag::O_RDONLY));
        match opened {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
}

struct TraceLocation {
    directory: File,
    leaf: OsString,
}

pub(super) struct TraceFile {
    location: TraceLocation,
    limit: usize,
}

impl TraceFile {
    pub(super) fn new(path: &Path, limit: usize) -> io::Result<Self> {
        if !(1024..=TRACE_BYTES).contains(&limit) {
            return Err(crate::refused());
        }
        let file = Self {
            location: TracePath::new(path)?.anchor()?,
            limit,
        };
        file.open()?;
        Ok(file)
    }

    fn open(&self) -> io::Result<File> {
        open_trace(
            &self.location.directory,
            &self.location.leaf,
            OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_APPEND,
        )
    }

    pub(super) fn append(&self, kind: &str, mut text: &str) -> io::Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let lock = Flock::lock(self.open()?, FlockArg::LockExclusiveNonblock);
        let mut file = match lock {
            Ok(file) => file,
            Err((_, Errno::EWOULDBLOCK)) => return Ok(()),
            Err((_, error)) => return Err(error.into()),
        };
        let chunk_chars = EVENT_CHARS.min((self.limit - 512) / 4);
        while !text.is_empty() {
            let end = text
                .char_indices()
                .nth(chunk_chars)
                .map_or(text.len(), |(end, _)| end);
            let raw = json!({"kind": kind, "text": &text[..end]}).to_string();
            write_line(&mut file, raw, self.limit)?;
            text = &text[end..];
        }
        Ok(())
    }
}

fn open_trace(directory: &File, leaf: &OsStr, access: OFlag) -> io::Result<File> {
    let flags = access | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
    let file = File::from(openat(
        directory,
        leaf,
        flags,
        Mode::S_IRUSR | Mode::S_IWUSR,
    )?);
    let info = file.metadata()?;
    if !info.is_file()
        || info.uid() != getuid().as_raw()
        || info.mode() & 0o7777 != 0o600
        || info.nlink() != 1
        || info.len() > TRACE_BYTES as u64
    {
        return Err(crate::refused());
    }
    Ok(file)
}

fn write_line(file: &mut File, mut raw: String, limit: usize) -> io::Result<()> {
    raw.push('\n');
    let size = file.metadata()?.len();
    if size.saturating_add(raw.len() as u64) > limit as u64 {
        file.set_len(0)?;
    }
    if file.metadata()?.len() == 0 {
        let mut random = [0; 16];
        getrandom::getrandom(&mut random)
            .map_err(|_| io::Error::other("trace reset entropy unavailable"))?;
        random[6] = (random[6] & 0x0f) | 0x40;
        random[8] = (random[8] & 0x3f) | 0x80;
        writeln!(
            file,
            "{{\"reset\": \"{:032x}\"}}",
            u128::from_be_bytes(random)
        )?;
    }
    file.write_all(raw.as_bytes())
}
