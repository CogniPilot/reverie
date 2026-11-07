use super::*;
use reverie_contracts::worker_nix::diagnostics_tail;
use std::{io::Write, os::unix::fs::MetadataExt};

pub(super) fn write(record: &Record, stdout: &[u8], stderr: &[u8]) -> Result<()> {
    let source = NixConfiguration::capture(&record.prepared);
    let identity = identity(&source)?;
    let current = storage_identity::storage_paths(&identity, record.resources().guard.session())?;
    need(
        current == *record.resources().storage.paths(),
        NixFault::StoreBinding,
    )?;
    let parent = Directory::open(current.home(), source.uid()?)?;
    let result = write_held(&parent, source.uid()?, stdout, stderr);
    finalized(result, parent.close().map_err(Into::into))
}
fn write_held(parent: &Directory, uid: u32, stdout: &[u8], stderr: &[u8]) -> Result<()> {
    // Open without TRUNC first: never damage a FIFO, foreign inode or hardlink
    // before metadata/entry custody checks. New files retain source mode0600.
    let mut file = parent.nix_log_writer()?;
    let result = (|| {
        let before = file.metadata()?;
        need(
            before.is_file() && before.uid() == uid && before.nlink() == 1,
            NixFault::StoreBinding,
        )?;
        let stamp = native::Stamp::of(&before);
        let entry = parent.nix_log_anchor()?;
        let checked = (|| {
            need(
                native::Stamp::of(&entry.metadata()?) == stamp,
                NixFault::StoreBinding,
            )?;
            let data = diagnostics_tail(
                std::str::from_utf8(stdout).expect("strict logs capture"),
                std::str::from_utf8(stderr).expect("strict logs capture"),
            );
            file.set_len(0)?;
            file.write_all(data.as_bytes())?;
            Ok(())
        })();
        finalized(checked, native::close(entry).map_err(Into::into))
    })();
    finalized(result, native::close(file).map_err(Into::into))
}
