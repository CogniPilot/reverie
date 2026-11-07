//! Fixed cold namespace moves. The real storage transaction must already own
//! and validate its pending fence, parent, epoch and fresh-stage descriptors.
#![forbid(unsafe_code)]
use reverie_core::ids::NativeOperationId;
use std::{ffi::CString, fs::File, io};
pub(crate) fn retire(parent: &File, epoch: &File) -> io::Result<()> {
    super::rename::noreplace(parent, c"tmp", epoch, c"data")
}
pub(crate) fn install(parent: &File, attempt: &NativeOperationId) -> io::Result<()> {
    let fresh = CString::new(format!(".cold-fresh-{}", attempt.as_str())).expect("checked UUID");
    super::rename::noreplace(parent, &fresh, parent, c"tmp")
}
#[cfg(test)]
mod tests;
