//! Loader-selected configuration-file image binding. Ancestors may be aliases;
//! only the leaf is NOFOLLOW. This is an observation, never admission authority.
#![forbid(unsafe_code)]
use crate::{ObservationError, native};
use reverie_contracts::{
    reservation_control::{CurrentImageData, CurrentImageDataError},
    worker_config::EffectiveWorkerConfig,
};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};
const MAX: usize = 1 << 20;
#[derive(Debug)]
pub enum ImageHostError {
    Native(ObservationError),
    Data(CurrentImageDataError),
    Custody,
    Changed,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ImageHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Native(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Custody => "WORKER_IMAGE_CONFIGURATION_CUSTODY",
            Self::Changed => "WORKER_IMAGE_CONFIGURATION_CHANGED",
            Self::Finalization { .. } => "WORKER_IMAGE_CONFIGURATION_FINALIZATION",
        }
    }
}
impl fmt::Display for ImageHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ImageHostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Native(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Finalization { primary, .. } => Some(&**primary),
            Self::Custody | Self::Changed => None,
        }
    }
}
impl From<io::Error> for ImageHostError {
    fn from(error: io::Error) -> Self {
        Self::Native(error.into())
    }
}
impl From<ObservationError> for ImageHostError {
    fn from(error: ObservationError) -> Self {
        Self::Native(error)
    }
}
type Result<T> = std::result::Result<T, ImageHostError>;
#[derive(Debug, Eq, PartialEq)]
struct ImageStamp {
    device: u64,
    inode: u64,
    uid: u32,
    mode: u32,
    links: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
impl ImageStamp {
    fn of(info: &fs::Metadata) -> Self {
        Self {
            device: info.dev(),
            inode: info.ino(),
            uid: info.uid(),
            mode: info.mode() & 0o7777,
            links: info.nlink(),
            size: info.len(),
            mtime: (info.mtime(), info.mtime_nsec()),
            ctime: (info.ctime(), info.ctime_nsec()),
        }
    }
}
/// Actual closed-file observation bound to its loader-selected native spelling.
/// No public constructor or mutable expected identity is exposed.
#[derive(Debug)]
pub struct CurrentImageBinding {
    path: PathBuf,
    expected: ImageStamp,
}
impl CurrentImageBinding {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub fn assert_current(&self) -> Result<()> {
        need(
            ImageStamp::of(&fs::symlink_metadata(&self.path)?) == self.expected,
            ImageHostError::Changed,
        )
    }
}
/// The installing application supplies the source retained by its owner loader;
/// request data must not select this path or suppress a loader-selected binding.
/// Embedded captured configurations are handled by the application separately.
pub fn capture_current_image(
    path: &Path,
    config: &EffectiveWorkerConfig,
) -> Result<CurrentImageBinding> {
    let expected = ImageStamp::of(&fs::symlink_metadata(path)?);
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let parsed = read(&mut file, path, &expected);
    let closed = native::close(file).map_err(ImageHostError::Native);
    let data = finalized(parsed, closed)?;
    data.validate(config).map_err(ImageHostError::Data)?;
    let binding = CurrentImageBinding {
        path: path.to_owned(),
        expected,
    };
    binding.assert_current()?;
    Ok(binding)
}
fn read(file: &mut File, path: &Path, expected: &ImageStamp) -> Result<CurrentImageData> {
    let opened = file.metadata()?;
    need(
        opened.is_file()
            && opened.uid() == native::uid()
            && opened.nlink() == 1
            && opened.mode() & 0o077 == 0
            && opened.len() <= MAX as u64,
        ImageHostError::Custody,
    )?;
    need(
        ImageStamp::of(&opened) == *expected,
        ImageHostError::Changed,
    )?;
    let mut raw = Vec::new();
    (&mut *file).take((MAX + 1) as u64).read_to_end(&mut raw)?;
    #[cfg(test)]
    native::test_faults::after_read(path)?;
    #[cfg(not(test))]
    let _ = path;
    need(
        raw.len() as u64 == opened.len()
            && raw.len() <= MAX
            && ImageStamp::of(&file.metadata()?) == *expected,
        ImageHostError::Changed,
    )?;
    CurrentImageData::decode(&raw).map_err(ImageHostError::Data)
}
fn need(value: bool, error: ImageHostError) -> Result<()> {
    if value { Ok(()) } else { Err(error) }
}
fn finalized<T>(value: Result<T>, closed: Result<()>) -> Result<T> {
    match (value, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ImageHostError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
#[cfg(test)]
mod tests;
