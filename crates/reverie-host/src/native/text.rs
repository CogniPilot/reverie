//! Python os.fsencode/fsdecode's POSIX surrogateescape conversion. No path
//! normalization, replacement characters, filesystem lookup or authority.
#![forbid(unsafe_code)]
use std::ffi::OsString;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

pub(crate) fn python_path(points: &[u32]) -> std::io::Result<PathBuf> {
    let bytes =
        reverie_core::posix_text::encode(points).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    Ok(OsString::from_vec(bytes).into())
}
pub(crate) fn python_text(path: &Path) -> Vec<u32> {
    reverie_core::posix_text::decode(path.as_os_str().as_bytes())
}

#[cfg(test)]
mod tests;
