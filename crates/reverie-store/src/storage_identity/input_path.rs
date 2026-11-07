//! Captured path DATA, without early string encoding or filesystem checks.
//! Every actual metadata read still owns canonical/no-follow custody itself.
use super::{IdentityFault, Result, need};
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::{posix_path::PosixPath, posix_text};
use std::{ffi::OsString, io, os::unix::ffi::OsStringExt, path::PathBuf};
#[derive(Clone, Debug)]
pub(super) enum InputPath {
    Native(PathBuf),
    WorkerText(MetadataText),
}
impl InputPath {
    pub(super) fn raw(&self) -> Result<PathBuf> {
        match self {
            Self::Native(path) => Ok(path.clone()),
            Self::WorkerText(text) => {
                let path = PosixPath::try_new(text.codepoints())
                    .map_err(|_| super::IdentityError::Refused(IdentityFault::CanonicalPath))?;
                need(
                    path.codepoints() == text.codepoints()
                        && path.is_single_rooted()
                        && !path.has_parent_component(),
                    IdentityFault::CanonicalPath,
                )?;
                Ok(encode(text.codepoints())?)
            }
        }
    }
    /// Python Path(text) before indexed lookup folds '.' and repeat/trailing
    /// separators, while the later canonical(str) still sees the raw spelling.
    pub(super) fn pathlike(&self) -> io::Result<PathBuf> {
        match self {
            Self::Native(path) => Ok(path.clone()),
            Self::WorkerText(text) => {
                let path = PosixPath::try_new(text.codepoints())
                    .map_err(|_| io::ErrorKind::InvalidInput)?;
                encode(&path.codepoints())
            }
        }
    }
}
fn encode(points: &[u32]) -> io::Result<PathBuf> {
    let bytes = posix_text::encode(points).map_err(|_| io::ErrorKind::InvalidInput)?;
    Ok(OsString::from_vec(bytes).into())
}
