//! Explicit own-epoch 24h reservation under the same real canonical barrier.
//! Metadata is never used instead of the later complete EX retirement scan.
use super::super::Directory;
use super::*;
use reverie_contracts::worker_cold_tmp::{
    RetainedReservationUntil, retained_path_record, retained_reservation_record,
};
use reverie_core::ids::NativeOperationId;
use std::io::Write;
impl Bases {
    pub(in crate::worker_storage::cold_tmp) fn reserve_epoch(
        &mut self,
        home: &PosixPath,
        epoch: &Directory,
        attempt: &NativeOperationId,
        end: Instant,
    ) -> Result<RetainedReservationUntil> {
        let own = home.join(&PosixPath::from_scalar_text(".local/state/reverie/leases"));
        let base = self
            .bases
            .iter_mut()
            .find(|base| base.directory.text == own)
            .ok_or(StorageError::Refused(StorageFault::ColdLease))?;
        base.directory.check()?;
        epoch.check()?;
        check(end)?;
        need(base.barrier.is_none(), StorageFault::ColdLease)?;
        base.barrier = Some(native::open_at_mode(
            base.directory.file.as_raw_fd(),
            OsStr::new("barrier.lock"),
            libc::O_RDWR | libc::O_CREAT | libc::O_NONBLOCK,
            0o600,
        )?);
        let result = (|| {
            let barrier = base.barrier.as_ref().expect("adopted SH barrier");
            base.barrier_owner(barrier)?;
            barrier
                .try_lock_shared()
                .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
            base.reserve_records(epoch, attempt, end)
        })();
        finalized(
            result,
            fs::close(base.barrier.take().expect("original SH barrier")),
        )
    }
}
impl Base {
    fn reserve_records(
        &self,
        epoch: &Directory,
        attempt: &NativeOperationId,
        end: Instant,
    ) -> Result<RetainedReservationUntil> {
        check(end)?;
        let info = epoch.file.metadata()?;
        let key = format!("{}-{}", info.dev(), info.ino());
        let now = clock();
        let path = OsString::from(format!("{key}.path.json"));
        if !self.exists(&path)? {
            self.replace_epoch_record(
                &path,
                &retained_path_record(&epoch.text, clock()),
                attempt,
                "path",
                end,
            )?;
        }
        let reserve = OsString::from(format!("{key}.reserve.json"));
        self.replace_epoch_record(
            &reserve,
            &retained_reservation_record(&epoch.text, now),
            attempt,
            "reservation",
            end,
        )?;
        for name in [&path, &reserve] {
            let file = native::open_at(
                self.directory.file.as_raw_fd(),
                name,
                libc::O_RDONLY | libc::O_NONBLOCK,
            )?;
            let result = file.sync_all().map_err(Into::into);
            finalized(result, fs::close(file))?;
        }
        self.directory.file.sync_all()?;
        self.directory.check()?;
        epoch.check()?;
        Ok(self.retained_record(&reserve, end)?.reservation_until()?)
    }
    fn replace_epoch_record(
        &self,
        target: &OsStr,
        raw: &[u8],
        attempt: &NativeOperationId,
        kind: &str,
        end: Instant,
    ) -> Result<()> {
        check(end)?;
        self.directory.check()?;
        // Unlike the old predictable TRUNC temporary, never overwrite a foreign
        // partial record. This fresh attempt-owned name is not exposed publicly.
        let name = OsString::from(format!(".retained-{}-{kind}.tmp", attempt.as_str()));
        let mut output = native::open_at_mode(
            self.directory.file.as_raw_fd(),
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
            0o600,
        )?;
        let written = output.write_all(raw).map_err(Into::into);
        finalized(written, fs::close(output))?;
        check(end)?;
        nix::fcntl::renameat(
            &self.directory.file,
            name.as_os_str(),
            &self.directory.file,
            target,
        )
        .map_err(std::io::Error::from)?;
        self.directory.check()
    }
}
fn clock() -> f64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_secs_f64(),
        Err(error) => -error.duration().as_secs_f64(),
    }
}
