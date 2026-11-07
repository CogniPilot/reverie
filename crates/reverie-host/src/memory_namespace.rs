//! Pin the actual calling process namespace for installed memory operations.
//! These observations are not caller authentication or an employee/scope grant.
//! A host service must not interpret a guest path or loopback endpoint here.
use crate::{ObservationError, native};
use std::{
    fmt,
    fs::{File, OpenOptions},
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};

const ENTRIES: [&str; 5] = [
    "/proc/thread-self/ns/user",
    "/proc/thread-self/ns/mnt",
    "/proc/thread-self/ns/net",
    "/proc/thread-self/root",
    "/proc/thread-self/cwd",
];

#[derive(Debug)]
pub enum NamespaceError {
    Io(io::Error),
    Native(ObservationError),
    Changed,
    Closed,
    CloseUnconfirmed,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl fmt::Display for NamespaceError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::Io(_) | Self::Native(_) => "memory namespace observation failed",
            Self::Changed => "memory process namespace changed",
            Self::Closed => "memory namespace is closed",
            Self::CloseUnconfirmed => "memory namespace closure is unconfirmed",
            Self::Finalization { .. } => "memory namespace observation and closure failed",
        })
    }
}
impl std::error::Error for NamespaceError {}
impl From<io::Error> for NamespaceError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
struct Entry {
    file: Option<File>,
    identity: [u64; 2],
}
#[derive(Clone, Copy, PartialEq)]
enum State {
    Active,
    Closed,
    Unconfirmed,
}
#[must_use = "retain and explicitly close the actual namespace descriptors"]
pub struct MemoryNamespace {
    credentials: [u32; 4],
    entries: Vec<Entry>,
    state: State,
}
impl MemoryNamespace {
    /// Fixed procfs observations in this process only. Deliberately follows the
    /// kernel's own magic links, holding every resulting inode until close.
    pub fn capture_current() -> Result<Self, NamespaceError> {
        let mut held = Self {
            credentials: native::memory_credentials(),
            entries: Vec::new(),
            state: State::Active,
        };
        let result = held.capture_entries().and_then(|()| held.assert_current());
        match result {
            Ok(()) => Ok(held),
            Err(primary) => finalized(Err(primary), held.close_entries()),
        }
    }
    fn capture_entries(&mut self) -> Result<(), NamespaceError> {
        for path in ENTRIES {
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_PATH | libc::O_CLOEXEC)
                .open(path)?;
            let identity = file.metadata().map(|m| [m.dev(), m.ino()]);
            match identity {
                Ok(identity) => self.entries.push(Entry {
                    file: Some(file),
                    identity,
                }),
                Err(error) => {
                    return finalized(
                        Err(error.into()),
                        native::close(file).map_err(NamespaceError::Native),
                    );
                }
            }
        }
        Ok(())
    }
    pub fn assert_current(&self) -> Result<(), NamespaceError> {
        self.require_active()?;
        if self.entries.len() != ENTRIES.len() || native::memory_credentials() != self.credentials {
            return Err(NamespaceError::Changed);
        }
        for (path, entry) in ENTRIES.into_iter().zip(&self.entries) {
            let held = entry
                .file
                .as_ref()
                .ok_or(NamespaceError::Closed)?
                .metadata()?;
            let current = std::fs::metadata(path)?;
            if [held.dev(), held.ino()] != entry.identity
                || [current.dev(), current.ino()] != entry.identity
            {
                return Err(NamespaceError::Changed);
            }
        }
        Ok(())
    }
    /// A failed explicit close remains fenced on subsequent calls. All held
    /// descriptors are attempted even when an earlier close reports failure.
    pub fn close(&mut self) -> Result<(), NamespaceError> {
        match self.state {
            State::Closed => return Ok(()),
            State::Unconfirmed => return Err(NamespaceError::CloseUnconfirmed),
            State::Active => (),
        }
        let checked = self.assert_current();
        let result = finalized(checked, self.close_entries());
        if result.is_err() {
            self.state = State::Unconfirmed;
        }
        result
    }
    fn close_entries(&mut self) -> Result<(), NamespaceError> {
        self.state = State::Unconfirmed;
        let mut result = Ok(());
        for entry in &mut self.entries {
            if let Some(file) = entry.file.take() {
                result = finalized(result, native::close(file).map_err(NamespaceError::Native));
            }
        }
        if result.is_ok() {
            self.state = State::Closed;
        }
        result
    }
    fn require_active(&self) -> Result<(), NamespaceError> {
        match self.state {
            State::Active => Ok(()),
            State::Closed => Err(NamespaceError::Closed),
            State::Unconfirmed => Err(NamespaceError::CloseUnconfirmed),
        }
    }
}
fn finalized<T>(
    result: Result<T, NamespaceError>,
    close: Result<(), NamespaceError>,
) -> Result<T, NamespaceError> {
    match (result, close) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(NamespaceError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
#[cfg(test)]
mod tests;
