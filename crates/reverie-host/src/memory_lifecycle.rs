//! Purpose-specific shared/exclusive serialization for the installed memory
//! scope. A lock is not authentication, launch approval or permission to write.
//! Existing Python writers do not participate: runtime selection must remain
//! coordinated. No caller-selected arbitrary leaf or file editor is exposed.
use crate::{
    ObservationError,
    memory_configuration::{MemoryConfiguration, MemoryPath},
    native,
};
use reverie_core::memory::MemoryScope;
use std::{
    fmt,
    fs::{File, Metadata, OpenOptions},
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
};

#[derive(Debug)]
pub enum LifecycleError {
    Io(io::Error),
    Native(ObservationError),
    NotInitialized,
    Busy,
    Changed,
    Custody,
    Closed,
    CloseUnconfirmed,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl fmt::Display for LifecycleError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::NotInitialized => "memory scope is not initialized",
            Self::Busy => "memory scope is busy",
            Self::Changed => "memory scope control changed",
            Self::Custody => "memory scope control custody refused",
            Self::Closed => "memory scope control is closed",
            Self::CloseUnconfirmed => "memory scope control closure is unconfirmed",
            Self::Io(_) | Self::Native(_) => "memory scope control failed",
            Self::Finalization { .. } => "memory scope control and finalization failed",
        })
    }
}
impl std::error::Error for LifecycleError {}
impl From<io::Error> for LifecycleError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum State {
    Active,
    Closed,
    Unconfirmed,
}
#[must_use = "retain the actual scope lock through the entire operation and close it"]
pub struct MemoryOperationLock {
    directory: PathBuf,
    parent: Option<File>,
    parent_id: Option<[u64; 2]>,
    lock: Option<File>,
    lock_id: Option<[u64; 2]>,
    uid: u32,
    state: State,
}
pub fn scope_directory(
    configuration: &MemoryConfiguration,
    scope: &MemoryScope,
) -> io::Result<PathBuf> {
    let data = configuration.native_path(MemoryPath::Data)?;
    Ok(match scope {
        MemoryScope::Private => data,
        MemoryScope::Project(project) => data.join("projects").join(project.as_str()),
    })
}
impl MemoryOperationLock {
    pub fn database_path(&self) -> PathBuf {
        self.directory.join("memory.sqlite")
    }
    /// Explicit startup only. The lifecycle service prepares the scope directory
    /// first; only this fixed control leaf is created here, never a database.
    pub fn startup(
        configuration: &MemoryConfiguration,
        scope: &MemoryScope,
    ) -> Result<Self, LifecycleError> {
        Self::acquire(scope_directory(configuration, scope)?, true)
    }
    /// Missing directory/control is a typed refusal, without creating anything.
    pub fn recall(
        configuration: &MemoryConfiguration,
        scope: &MemoryScope,
    ) -> Result<Self, LifecycleError> {
        Self::acquire(scope_directory(configuration, scope)?, false)
    }
    fn acquire(directory: PathBuf, exclusive: bool) -> Result<Self, LifecycleError> {
        let parent = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_PATH | libc::O_CLOEXEC)
            .open(&directory)
            .map_err(missing)?;
        let mut held = Self {
            directory,
            parent: Some(parent),
            parent_id: None,
            lock: None,
            lock_id: None,
            uid: native::memory_credentials()[1],
            state: State::Active,
        };
        let result = held.initialize(exclusive);
        match result {
            Ok(()) => Ok(held),
            Err(primary) => finalized(Err(primary), held.close_files()),
        }
    }
    fn initialize(&mut self, exclusive: bool) -> Result<(), LifecycleError> {
        let parent = self.parent.as_ref().expect("acquisition owns parent");
        let metadata = parent.metadata()?;
        self.parent_id = Some(identity(&metadata));
        parent_custody(&metadata, self.uid)?;
        self.lock = Some(native::memory_lock_file(parent, exclusive).map_err(
            |error| match error {
                ObservationError::Io(error) if error.kind() == io::ErrorKind::NotFound => {
                    LifecycleError::NotInitialized
                }
                error => LifecycleError::Native(error),
            },
        )?);
        let lock = self.lock.as_ref().expect("opened lock");
        let metadata = lock.metadata()?;
        self.lock_id = Some(identity(&metadata));
        lock_custody(&metadata, self.uid)?;
        native::memory_lock(lock, exclusive).map_err(|error| {
            if error.kind() == io::ErrorKind::WouldBlock {
                LifecycleError::Busy
            } else {
                LifecycleError::Io(error)
            }
        })?;
        self.assert_current()
    }
    pub fn assert_current(&self) -> Result<(), LifecycleError> {
        match self.state {
            State::Closed => return Err(LifecycleError::Closed),
            State::Unconfirmed => return Err(LifecycleError::CloseUnconfirmed),
            State::Active => (),
        }
        let parent = self.parent.as_ref().ok_or(LifecycleError::Closed)?;
        let current = std::fs::metadata(&self.directory)?;
        if Some(identity(&current)) != self.parent_id
            || Some(identity(&parent.metadata()?)) != self.parent_id
        {
            return Err(LifecycleError::Changed);
        }
        parent_custody(&current, self.uid)?;
        let lock = self
            .lock
            .as_ref()
            .ok_or(LifecycleError::Closed)?
            .metadata()?;
        lock_custody(&lock, self.uid)?;
        let named = native::memory_lock_entry(parent)?;
        let checked = named
            .metadata()
            .map_err(LifecycleError::Io)
            .and_then(|metadata| {
                lock_custody(&metadata, self.uid)?;
                if Some(identity(&metadata)) != self.lock_id
                    || Some(identity(&lock)) != self.lock_id
                {
                    return Err(LifecycleError::Changed);
                }
                Ok(())
            });
        finalized(
            checked,
            native::close(named).map_err(LifecycleError::Native),
        )
    }
    pub fn close(&mut self) -> Result<(), LifecycleError> {
        match self.state {
            State::Closed => return Ok(()),
            State::Unconfirmed => return Err(LifecycleError::CloseUnconfirmed),
            State::Active => (),
        }
        let checked = self.assert_current();
        let result = finalized(checked, self.close_files());
        if result.is_err() {
            self.state = State::Unconfirmed;
        }
        result
    }
    fn close_files(&mut self) -> Result<(), LifecycleError> {
        self.state = State::Unconfirmed;
        let mut result = Ok(());
        for slot in [&mut self.lock, &mut self.parent] {
            if let Some(file) = slot.take() {
                result = finalized(result, native::close(file).map_err(LifecycleError::Native));
            }
        }
        if result.is_ok() {
            self.state = State::Closed;
        }
        result
    }
}
fn identity(metadata: &Metadata) -> [u64; 2] {
    [metadata.dev(), metadata.ino()]
}
fn parent_custody(metadata: &Metadata, uid: u32) -> Result<(), LifecycleError> {
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o022 != 0 {
        return Err(LifecycleError::Custody);
    }
    Ok(())
}
fn lock_custody(metadata: &Metadata, uid: u32) -> Result<(), LifecycleError> {
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o777 != 0o600
        || metadata.len() != 0
    {
        return Err(LifecycleError::Custody);
    }
    Ok(())
}
fn missing(error: io::Error) -> LifecycleError {
    if error.kind() == io::ErrorKind::NotFound {
        LifecycleError::NotInitialized
    } else {
        error.into()
    }
}
fn finalized<T>(
    result: Result<T, LifecycleError>,
    close: Result<(), LifecycleError>,
) -> Result<T, LifecycleError> {
    match (result, close) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(LifecycleError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
#[cfg(test)]
mod tests;
