//! Python POSIX surrogateescape conversion and fixed metadata predicates.
//! Neither normalization nor effect/custody authority is supplied here.
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

/// Source Path.is_file disposition, shared by fixed receipt owners. This is
/// metadata DATA only; it never grants custody or effect/release permission.
pub(crate) fn python_is_file(codepoints: &[u32]) -> std::io::Result<bool> {
    let path = match python_path(codepoints) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => return Ok(false),
        Err(error) => return Err(error),
    };
    match std::fs::metadata(path) {
        Ok(info) => Ok(info.is_file()),
        Err(error)
            if error.kind() == std::io::ErrorKind::InvalidInput
                || matches!(
                    error.raw_os_error(),
                    Some(libc::ENOENT | libc::ENOTDIR | libc::EBADF | libc::ELOOP)
                ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests;
