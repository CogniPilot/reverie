//! Read-only installed memory selection in THIS process namespace. The fixed
//! file is bootstrap data, never a grant; callers still authorize every use.
use crate::native;
use reverie_contracts::memory_context::{self as wire, ContextCodecError};
use reverie_core::memory_context::InstalledMemoryContext;
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata},
    io::{self, Read},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

#[derive(Debug)]
pub enum ContextError {
    Io(io::Error),
    Native(crate::ObservationError),
    Codec(ContextCodecError),
    Custody,
    Changed,
    Closed,
    CloseUnconfirmed,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for ContextError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Finalization { primary, secondary } => {
                write!(out, "{primary}; finalizer: {secondary}")
            }
            _ => out.write_str("installed memory context unavailable"),
        }
    }
}
impl std::error::Error for ContextError {}
impl From<io::Error> for ContextError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
type Result<T> = std::result::Result<T, ContextError>;
fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ContextError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
struct Entry {
    path: PathBuf,
    file: File,
    stamp: Option<native::Stamp>,
    directory: Option<[u64; 5]>,
}
fn directory_key(metadata: &Metadata) -> [u64; 5] {
    [
        metadata.dev(),
        metadata.ino(),
        u64::from(metadata.uid()),
        u64::from(metadata.gid()),
        u64::from(metadata.mode()),
    ]
}
impl Entry {
    fn assert_current(&self) -> Result<()> {
        let held = self.file.metadata()?;
        let named = fs::symlink_metadata(&self.path)?;
        let same = if let Some(key) = self.directory {
            held.is_dir()
                && named.is_dir()
                && directory_key(&held) == key
                && directory_key(&named) == key
        } else {
            self.stamp.as_ref().is_some_and(|stamp| {
                native::Stamp::of(&held) == *stamp && native::Stamp::of(&named) == *stamp
            })
        };
        if same {
            Ok(())
        } else {
            Err(ContextError::Changed)
        }
    }
}
#[derive(Clone, Copy, PartialEq)]
enum State {
    Active,
    Closed,
    Unconfirmed,
}

#[must_use = "retain the actual installed context observation and explicitly close it"]
pub struct InstalledContext {
    context: Option<InstalledMemoryContext>,
    fingerprint: Option<wire::ContextFingerprint>,
    entries: Vec<Entry>,
    state: State,
}
impl InstalledContext {
    /// No environment, request or caller-selected file path participates.
    /// Absence disables this optional installed consumer; corruption refuses.
    pub fn capture() -> Result<Option<Self>> {
        match Self::capture_at(Path::new(wire::INSTALLED_CONTEXT_PATH)) {
            Ok(value) => Ok(Some(value)),
            Err(ContextError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    fn capture_at(path: &Path) -> Result<Self> {
        let mut observed = Self {
            context: None,
            fingerprint: None,
            entries: Vec::new(),
            state: State::Active,
        };
        let result = observed.read(path);
        match result {
            Ok(()) => Ok(observed),
            Err(primary) => finalized(Err(primary), observed.close()),
        }
    }
    fn read(&mut self, path: &Path) -> Result<()> {
        if !path.is_absolute()
            || !path
                .components()
                .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err(ContextError::Custody);
        }
        let components = path.components().collect::<Vec<_>>();
        let mut named = PathBuf::from("/");
        for (index, part) in components.iter().enumerate() {
            let leaf = index + 1 == components.len();
            let parent = self
                .entries
                .last()
                .map_or(libc::AT_FDCWD, |entry| entry.file.as_raw_fd());
            let name = if index == 0 {
                OsStr::new("/")
            } else {
                part.as_os_str()
            };
            if index > 0 {
                named.push(name);
            }
            let flags =
                libc::O_RDONLY | libc::O_NONBLOCK | if leaf { 0 } else { libc::O_DIRECTORY };
            let file = native::open_at(parent, name, flags)?;
            // Adopt before any fallible metadata/read operation.
            self.entries.push(Entry {
                path: named.clone(),
                file,
                stamp: None,
                directory: None,
            });
            self.check_entry(leaf)?;
        }
        let leaf = self.entries.last_mut().ok_or(ContextError::Custody)?;
        let mut bytes = Vec::new();
        (&mut leaf.file)
            .take((wire::MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > wire::MAX_BYTES {
            return Err(ContextError::Custody);
        }
        leaf.assert_current()?;
        self.context = Some(wire::decode(&bytes).map_err(ContextError::Codec)?);
        self.fingerprint = Some(wire::fingerprint(&bytes).map_err(ContextError::Codec)?);
        self.assert_current()
    }
    fn check_entry(&mut self, leaf: bool) -> Result<()> {
        let entry = self.entries.last_mut().ok_or(ContextError::Custody)?;
        let metadata = entry.file.metadata()?;
        entry.stamp = Some(native::Stamp::of(&metadata));
        entry.directory = (!leaf).then(|| directory_key(&metadata));
        let owner = [0, native::uid()].contains(&metadata.uid());
        let allowed = if leaf {
            metadata.is_file()
                && metadata.nlink() == 1
                && metadata.mode() & 0o222 == 0
                && metadata.len() <= wire::MAX_BYTES as u64
        } else {
            metadata.is_dir()
                && (metadata.mode() & 0o022 == 0
                    || metadata.uid() == 0 && metadata.mode() & 0o1000 != 0)
        };
        if !owner || !allowed {
            return Err(ContextError::Custody);
        }
        entry.assert_current()
    }
    pub fn data(&self) -> &InstalledMemoryContext {
        self.context
            .as_ref()
            .expect("successful capture installs checked context data")
    }
    /// Exact bytes only; this fingerprint confers no permission.
    pub fn fingerprint(&self) -> &wire::ContextFingerprint {
        self.fingerprint
            .as_ref()
            .expect("successful capture installs a byte fingerprint")
    }
    pub fn assert_current(&self) -> Result<()> {
        if self.state != State::Active {
            return Err(ContextError::Closed);
        }
        for entry in &self.entries {
            entry.assert_current()?;
        }
        Ok(())
    }
    pub fn close(&mut self) -> Result<()> {
        if self.state == State::Unconfirmed {
            return Err(ContextError::CloseUnconfirmed);
        }
        if self.state == State::Closed {
            return Ok(());
        }
        let mut result = Ok(());
        while let Some(entry) = self.entries.pop() {
            let checked = if entry.stamp.is_some() {
                entry.assert_current()
            } else {
                Ok(())
            };
            let closed = native::close(entry.file).map_err(ContextError::Native);
            result = finalized(result, finalized(checked, closed));
        }
        self.state = if result.is_ok() {
            State::Closed
        } else {
            State::Unconfirmed
        };
        result
    }
}

#[cfg(test)]
mod tests;
