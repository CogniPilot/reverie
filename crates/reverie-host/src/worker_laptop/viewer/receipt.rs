//! Path.is_file for a purpose-derived completion path. This private predicate
//! grants no stop/release authority and retains the source alias semantics.
use super::*;
use reverie_core::posix_path::PosixPath;
pub(in crate::worker_laptop) fn is_file(path: &PosixPath) -> Result<bool> {
    crate::native::python_is_file(&path.codepoints()).map_err(LaptopError::Io)
}
