//! Python os.fsencode/fsdecode's POSIX surrogateescape conversion. No path
//! normalization, replacement characters, filesystem lookup or authority.
#![forbid(unsafe_code)]
use std::ffi::OsString;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

pub(crate) fn python_path(points: &[u32]) -> std::io::Result<PathBuf> {
    let mut bytes = Vec::new();
    for &point in points {
        if (0xdc80..=0xdcff).contains(&point) {
            bytes.push((point - 0xdc00) as u8);
            continue;
        }
        let character = char::from_u32(point).ok_or(std::io::ErrorKind::InvalidInput)?;
        let mut encoded = [0; 4];
        bytes.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
    }
    Ok(OsString::from_vec(bytes).into())
}
pub(crate) fn python_text(path: &Path) -> Vec<u32> {
    let mut bytes = path.as_os_str().as_bytes();
    let mut points = Vec::new();
    while !bytes.is_empty() {
        match std::str::from_utf8(bytes) {
            Ok(value) => {
                points.extend(value.chars().map(u32::from));
                break;
            }
            Err(error) => {
                let prefix = std::str::from_utf8(&bytes[..error.valid_up_to()])
                    .expect("UTF-8 error identifies a valid prefix");
                points.extend(prefix.chars().map(u32::from));
                bytes = &bytes[error.valid_up_to()..];
                let invalid = error.error_len().unwrap_or(bytes.len());
                points.extend(
                    bytes[..invalid]
                        .iter()
                        .map(|&byte| 0xdc00 + u32::from(byte)),
                );
                bytes = &bytes[invalid..];
            }
        }
    }
    points
}

#[cfg(test)]
mod tests;
