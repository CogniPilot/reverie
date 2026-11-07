use super::*;
use std::{ffi::OsStr, os::unix::fs::MetadataExt};
pub(super) fn close(slot: &mut Option<File>, opaque: &mut bool) -> Result<()> {
    let Some(file) = slot.take() else {
        return Ok(());
    };
    let result = native::close(file).map_err(LaptopError::Observation);
    #[cfg(test)]
    let result = finalized(result, super::test_hooks::after_actual_close());
    if result.is_err() {
        *opaque = true;
    }
    result
}
pub(super) fn private_record(file: &File, uid: u32) -> Result<native::Stamp> {
    let info = file.metadata().map_err(LaptopError::Io)?;
    need(
        info.is_file() && info.uid() == uid && info.nlink() == 1 && info.mode() & 0o077 == 0,
        "WORKER_LAPTOP_RECORD_CUSTODY",
    )?;
    Ok(native::Stamp::of(&info))
}
pub(super) fn metadata_target(file: &File, uid: u32) -> Result<()> {
    let info = file.metadata().map_err(LaptopError::Io)?;
    need(
        info.is_file() && info.uid() == uid && info.nlink() == 1,
        "WORKER_LAPTOP_RUNTIME_METADATA_ALIAS",
    )
}
pub(super) fn current(
    parent: &File,
    name: &OsStr,
    anchor: &File,
    expected: &native::Stamp,
) -> Result<()> {
    let held = native::Stamp::of(&anchor.metadata().map_err(LaptopError::Io)?);
    let named = native::open_at(parent.as_raw_fd(), name, libc::O_PATH).map_err(LaptopError::Io)?;
    let result = named.metadata().map_err(LaptopError::Io).and_then(|info| {
        need(
            held == *expected && native::Stamp::of(&info) == *expected,
            "WORKER_LAPTOP_PUBLICATION_CHANGED",
        )
    });
    finalized(
        result,
        native::close(named).map_err(LaptopError::Observation),
    )
}
