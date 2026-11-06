//! Owner configuration text capture, without imposing OPS/lease ancestor rules.
//! The legacy loader permits hard links and symlinked ancestors. Concurrent
//! replacement/change refuses; no descriptor remains held after this read.
use super::{Stamp, close, uid};
use crate::observation::{ObservationFault, Result, finalized, need};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    path::Path,
};
#[cfg(test)]
mod tests;

pub(crate) fn read_worker_config(path: &Path) -> Result<Vec<u8>> {
    read_owned_text_file(path, uid())
}
/// Shared private regular text-file snapshot owner. Callers choose the original
/// fixed purpose UID; no raw path reader is exported outside Host.
pub(crate) fn read_owned_text_file(path: &Path, owner: u32) -> Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    need(
        before.is_file() && before.uid() == owner && before.mode() & 0o077 == 0,
        ObservationFault::ArtifactCustody,
    )?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let result = (|| {
        let opened = file.metadata()?;
        need(
            Stamp::of(&before) == Stamp::of(&opened),
            ObservationFault::Changed,
        )?;
        let mut bytes = Vec::new();
        // The original loader imposes no raw byte bound. Stage and wire limits
        // are separate contracts and must not silently constrain this reader.
        file.read_to_end(&mut bytes)?;
        #[cfg(test)]
        super::test_faults::after_read(path)?;
        need(
            Stamp::of(&opened) == Stamp::of(&file.metadata()?)
                && Stamp::of(&opened) == Stamp::of(&fs::symlink_metadata(path)?)
                && bytes.len() as u64 == opened.len(),
            ObservationFault::Changed,
        )?;
        Ok(bytes)
    })();
    finalized(result, close(file))
}
