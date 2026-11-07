//! Pinned bounded strict bytes records, separate from clear's leaf-following,
//! unbounded Path.read_text compatibility owner.
use super::*;
use std::io::Read;
impl Base {
    pub(super) fn retained_record(
        &self,
        name: &OsStr,
        end: Instant,
    ) -> Result<RetainedLeaseRecord> {
        check(end)?;
        let mut file = native::open_at(
            self.directory.file.as_raw_fd(),
            name,
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?;
        let result = (|| {
            let before = Stamp::capture(&file.metadata()?);
            need(
                before.mode & libc::S_IFMT == libc::S_IFREG
                    && before.uid == self.directory.file.metadata()?.uid()
                    && before.mode & 0o022 == 0
                    && before.links == 1
                    && before.size <= 65536,
                StorageFault::ColdLease,
            )?;
            let raw = read(&mut file, end)?;
            let after = Stamp::capture(&file.metadata()?);
            let named = Stamp::capture(&std::fs::symlink_metadata(self.selected(name))?);
            need(
                before == after && after == named && raw.len() as u64 == before.size,
                StorageFault::ColdLease,
            )?;
            RetainedLeaseRecord::decode(&raw)
                .map_err(|_| StorageError::Refused(StorageFault::ColdLease))
        })();
        finalized(result, fs::close(file))
    }
}
fn read(file: &mut File, end: Instant) -> Result<Vec<u8>> {
    let mut raw = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        check(end)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(raw);
        }
        need(raw.len() + count <= 65536, StorageFault::ColdLease)?;
        raw.extend_from_slice(&buffer[..count]);
    }
}
