//! Explicit startup's derived-profile writer. The destination is fixed by a
//! captured memory installation; this is not an arbitrary file editing API.
//! Exclusive publication preserves an existing owner profile. Held temporary
//! descriptors prevent inode reuse during cleanup; same-UID namespace changes
//! remain observations rather than a filesystem lease.
use crate::{
    memory_configuration::{MemoryConfiguration, MemoryPath},
    native,
};
use reverie_core::PythonText;
use std::{
    fmt,
    fs::{self, File, Metadata},
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileOutcome {
    Existing,
    Installed,
}
#[derive(Debug)]
pub enum ProfileError {
    Io(io::Error),
    Native(crate::ObservationError),
    NonScalarText,
    Changed,
    Uncertain(Box<Self>),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl fmt::Display for ProfileError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(output),
            Self::Native(error) => error.fmt(output),
            value => write!(output, "{value:?}"),
        }
    }
}
impl std::error::Error for ProfileError {}
impl From<io::Error> for ProfileError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
pub struct ProfileFile(PathBuf);
impl ProfileFile {
    pub fn for_configuration(configuration: &MemoryConfiguration) -> io::Result<Self> {
        Ok(Self(configuration.native_path(MemoryPath::Profile)?))
    }
    pub fn is_present(&self) -> Result<bool, ProfileError> {
        exists(&self.0)
    }
    pub fn ensure(&self, text: &PythonText) -> Result<ProfileOutcome, ProfileError> {
        if exists(&self.0)? {
            return Ok(ProfileOutcome::Existing);
        }
        let text = text.as_text_ref();
        let text = text.scalar_text().ok_or(ProfileError::NonScalarText)?;
        let mut pending = Pending::open(&self.0)?;
        let result = pending.publish(text.as_bytes());
        pending.finish(result)
    }
}
struct Pending {
    destination: PathBuf,
    temporary: PathBuf,
    parent_path: PathBuf,
    parent: Option<File>,
    file: Option<File>,
    prepared: Option<native::Stamp>,
    attempted: bool,
}
impl Pending {
    fn open(destination: &Path) -> Result<Self, ProfileError> {
        if destination.file_name() != Some(std::ffi::OsStr::new("profile.md")) {
            return Err(ProfileError::Changed);
        }
        let parent_path = destination
            .parent()
            .ok_or(ProfileError::Changed)?
            .to_path_buf();
        fs::create_dir_all(&parent_path)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ProfileError::Changed)?
            .as_nanos();
        let parent = File::open(&parent_path)?;
        let temporary = parent_path.join(format!(
            ".profile-{}-{}-{nonce:x}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut pending = Self {
            destination: destination.into(),
            temporary,
            parent_path,
            parent: Some(parent),
            file: None,
            prepared: None,
            attempted: false,
        };
        match native::create_memory_profile(
            pending.parent.as_ref().expect("held parent"),
            pending.temporary.file_name().expect("owned temporary"),
        ) {
            Ok(file) => {
                pending.file = Some(file);
                Ok(pending)
            }
            Err(error) => pending.finish(Err(error.into())),
        }
    }
    fn check_parent(&self) -> Result<(), ProfileError> {
        let held = self.parent.as_ref().expect("held parent").metadata()?;
        let named = fs::metadata(&self.parent_path)?;
        if !held.is_dir() || held.dev() != named.dev() || held.ino() != named.ino() {
            return Err(ProfileError::Changed);
        }
        Ok(())
    }
    fn owns_temporary(&self) -> Result<bool, ProfileError> {
        let held = self.file.as_ref().expect("held writer").metadata()?;
        match self.named_metadata(self.temporary.file_name().expect("owned temporary")) {
            Ok(named) => {
                Ok(named.is_file() && held.dev() == named.dev() && held.ino() == named.ino())
            }
            Err(ProfileError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
    fn publish(&mut self, bytes: &[u8]) -> Result<ProfileOutcome, ProfileError> {
        self.prepare(bytes)?;
        #[cfg(test)]
        tests::after_prepare(&self.temporary);
        self.check_parent()?;
        self.check_prepared()?;
        self.attempted = true;
        self.install(bytes)
    }
    fn prepare(&mut self, bytes: &[u8]) -> Result<(), ProfileError> {
        let file = self.file.as_mut().expect("held writer");
        file.write_all(bytes)?;
        file.sync_all()?;
        let stamp = native::Stamp::of(&file.metadata()?);
        self.prepared = Some(stamp.clone());
        self.readback(bytes)?;
        if native::Stamp::of(&self.file.as_ref().expect("held writer").metadata()?) != stamp {
            return Err(ProfileError::Changed);
        }
        Ok(())
    }
    fn readback(&mut self, bytes: &[u8]) -> Result<(), ProfileError> {
        let file = self.file.as_mut().expect("held writer");
        file.seek(SeekFrom::Start(0))?;
        let mut readback = Vec::new();
        Read::by_ref(file)
            .take(bytes.len() as u64 + 1)
            .read_to_end(&mut readback)?;
        if readback != bytes {
            return Err(ProfileError::Changed);
        }
        Ok(())
    }
    fn check_prepared(&self) -> Result<(), ProfileError> {
        let stamp = self.prepared.as_ref().ok_or(ProfileError::Changed)?;
        if native::Stamp::of(&self.file.as_ref().expect("held writer").metadata()?) != *stamp
            || native::Stamp::of(
                &self.named_metadata(self.temporary.file_name().expect("owned temporary"))?,
            ) != *stamp
        {
            return Err(ProfileError::Changed);
        }
        Ok(())
    }
    fn install(&mut self, bytes: &[u8]) -> Result<ProfileOutcome, ProfileError> {
        match native::publish_memory_profile(
            self.parent.as_ref().expect("held parent"),
            self.temporary.file_name().expect("owned temporary leaf"),
        ) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                self.attempted = false;
                return if exists(&self.destination)? {
                    Ok(ProfileOutcome::Existing)
                } else {
                    Err(ProfileError::Changed)
                };
            }
            Err(error) => return Err(error.into()),
        }
        self.parent.as_ref().expect("held parent").sync_all()?;
        self.check_parent()?;
        let before = native::Stamp::of(&self.file.as_ref().expect("held writer").metadata()?);
        self.readback(bytes)?;
        if native::Stamp::of(&self.file.as_ref().expect("held writer").metadata()?) != before
            || native::Stamp::of(&self.named_metadata(std::ffi::OsStr::new("profile.md"))?)
                != before
        {
            return Err(ProfileError::Changed);
        }
        #[cfg(test)]
        tests::after_publish();
        Ok(ProfileOutcome::Installed)
    }
    fn finish<T>(mut self, mut result: Result<T, ProfileError>) -> Result<T, ProfileError> {
        if self.file.is_some() && !self.attempted {
            result = finalized(result, self.cleanup_temporary());
        }
        for file in [self.file.take(), self.parent.take()].into_iter().flatten() {
            result = finalized(result, native::close(file).map_err(ProfileError::Native));
        }
        if self.attempted {
            result.map_err(|error| ProfileError::Uncertain(Box::new(error)))
        } else {
            result
        }
    }
    fn cleanup_temporary(&self) -> Result<(), ProfileError> {
        self.check_parent()?;
        if !self.owns_temporary()? {
            return Ok(());
        }
        if self.prepared.is_some() {
            self.check_prepared()?;
        }
        native::remove_memory_profile(
            self.parent.as_ref().expect("held parent"),
            self.temporary.file_name().expect("owned temporary"),
        )?;
        Ok(())
    }
    fn named_metadata(&self, name: &std::ffi::OsStr) -> Result<Metadata, ProfileError> {
        let file = native::memory_profile_entry(self.parent.as_ref().expect("held parent"), name)?;
        let metadata = file.metadata().map_err(ProfileError::Io);
        finalized(metadata, native::close(file).map_err(ProfileError::Native))
    }
}
fn exists(path: &Path) -> Result<bool, ProfileError> {
    match fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
fn finalized<T>(
    primary: Result<T, ProfileError>,
    secondary: Result<(), ProfileError>,
) -> Result<T, ProfileError> {
    match (primary, secondary) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ProfileError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
#[cfg(test)]
mod tests;
