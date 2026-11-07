//! Path.is_file for a purpose-derived completion path. This private predicate
//! grants no stop/release authority and retains the source alias semantics.
use super::*;
use reverie_core::posix_path::PosixPath;
pub(in crate::worker_laptop) fn is_file(path: &PosixPath) -> Result<bool> {
    let path = match crate::native::python_path(&path.codepoints()) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => return Ok(false),
        Err(error) => return Err(LaptopError::Io(error)),
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
        Err(error) => Err(LaptopError::Io(error)),
    }
}
