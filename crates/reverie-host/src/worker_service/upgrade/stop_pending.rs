//! Explicit force-stopped retention of one exact original STOP marker. This
//! does not acknowledge its prior command or any R/resource completion.
use super::*;
use crate::worker_image::{
    ClosedImageMaintenance, ImageFileError, ImageMaintenanceFailure, ImageMaintenanceLocks,
};

pub(in crate::worker_service) struct StopPendingTakeover {
    locks: Option<ImageMaintenanceLocks>,
    closed: Option<ClosedImageMaintenance>,
    failure: Option<Box<ImageMaintenanceFailure>>,
    error: Option<ImageFileError>,
    close_attempted: bool,
    archive: Option<(PathBuf, native::PrivateFileStamp, u32)>,
}
struct StopOrigin<'a> {
    old: &'a Path,
    expected: &'a ExpectedCommands,
    source: &'a publication::SourceSnapshot,
    pending: &'a Path,
    stamp: &'a native::PrivateFileStamp,
    group: u32,
    original: usize,
    stopped: &'a ServiceGroupData,
}
const RECOVERY_DENIAL: &[u8] = b"NATIVE_STOP_RECOVERY_DENIAL_V1\n";
impl StopPendingTakeover {
    fn empty() -> Self {
        Self {
            locks: None,
            closed: None,
            failure: None,
            error: None,
            close_attempted: false,
            archive: None,
        }
    }
    fn capture(
        &mut self,
        source: &Path,
        config: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<()> {
        match ImageMaintenanceLocks::capture(source, config, end) {
            Ok(locks) => {
                self.locks = Some(locks);
                Ok(())
            }
            Err(failure) => {
                let code = failure.cause().code();
                self.failure = Some(failure);
                Err(WorkerServiceError::Program(code))
            }
        }
    }
    fn current(&mut self) -> Result<()> {
        let result = self
            .locks
            .as_mut()
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_SERVICE_STOP_TAKEOVER_LOCK_REQUIRED",
            ))?
            .assert_held_current();
        result.map_err(|error| {
            let code = error.code();
            self.error.get_or_insert(error);
            WorkerServiceError::Program(code)
        })
    }
    pub(in crate::worker_service) fn error(&self) -> Option<&ImageFileError> {
        self.error
            .as_ref()
            .or_else(|| self.failure.as_ref().map(|failure| failure.cause()))
    }
    pub(in crate::worker_service) fn close(&mut self) -> Result<()> {
        if self.close_attempted {
            return self
                .error()
                .map_or(Ok(()), |e| Err(WorkerServiceError::Program(e.code())));
        }
        self.close_attempted = true;
        if let Some(locks) = self.locks.take() {
            match locks.close() {
                Ok(closed) => self.closed = Some(closed),
                Err(failure) => {
                    self.error.get_or_insert_with(|| failure.cause().clone());
                    self.failure = Some(failure);
                }
            }
        }
        if let Some(failure) = &mut self.failure
            && let Err(error) = failure.close_components()
        {
            self.error.get_or_insert(error);
        }
        self.error()
            .map_or(Ok(()), |e| Err(WorkerServiceError::Program(e.code())))
    }
    pub(in crate::worker_service) fn assert_closed(&mut self) -> Result<()> {
        need(
            self.close_attempted && self.failure.is_none() && self.error.is_none(),
            "NATIVE_SERVICE_STOP_TAKEOVER_CLOSE_RETAINED",
        )?;
        let result = self
            .closed
            .as_ref()
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_SERVICE_STOP_TAKEOVER_CLOSE_REQUIRED",
            ))?
            .assert_current();
        result.map_err(|error| {
            let code = error.code();
            self.error.get_or_insert(error);
            WorkerServiceError::Program(code)
        })?;
        let (path, stamp, group) = self.archive.as_ref().ok_or(WorkerServiceError::Refused(
            "NATIVE_SERVICE_STOP_ARCHIVE_REQUIRED",
        ))?;
        let metadata = fs::symlink_metadata(path)?;
        need(
            native::PrivateFileStamp::of(&metadata) == *stamp && metadata.gid() == *group,
            "NATIVE_SERVICE_STOP_ARCHIVE_CHANGED",
        )
    }
}
impl State {
    pub(super) fn take_over_stopped_pending(
        &mut self,
        old: &Path,
        expected: &ExpectedCommands,
        source: &publication::SourceSnapshot,
    ) -> Result<Option<PathBuf>> {
        let path = self.folder().join("pending");
        let metadata = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
            Ok(metadata) => metadata,
        };
        private(&path, false)?;
        let stamp = native::PrivateFileStamp::of(&metadata);
        let group = metadata.gid();
        let raw = self.read_private(&path)?;
        need(
            raw.as_bytes() == pending_bytes(&WorkerServiceAction::Stop),
            "NATIVE_SERVICE_FORCE_REQUIRES_EXACT_STOP_PENDING",
        )?;
        let original = self.files.len() - 1;
        need(
            native::PrivateFileStamp::of(&self.files[original].metadata()?) == stamp,
            "NATIVE_SERVICE_STOP_PENDING_CHANGED",
        )?;
        let config = reverie_contracts::worker_config::decode(source.raw.as_bytes())
            .map_err(|_| WorkerServiceError::Refused("NATIVE_SERVICE_STOP_SOURCE_REQUIRED"))?;
        self.stop_takeover = Some(StopPendingTakeover::empty());
        self.stop_takeover
            .as_mut()
            .expect("original takeover")
            .capture(&self.source, &config, self.end)?;
        self.assert_upgrade_stopped(old, expected, true)?;
        let group_proof = self.force_stopped_group()?;
        need(
            self.source_snapshot()?.raw == source.raw,
            "NATIVE_SERVICE_UPGRADE_SOURCE_CHANGED",
        )?;
        // Existing old binaries do not take update.lock. Keep an ORIGINAL
        // run/failure fence across archive -> exclusive new pending, so an old
        // broker cannot start through that short name-change interval.
        let barrier = self.stop_pending_barrier(&StopOrigin {
            old,
            expected,
            source,
            pending: &path,
            stamp: &stamp,
            group,
            original,
            stopped: &group_proof,
        })?;
        let history = self.upgrade_history(old, &source.digest, true)?;
        self.assert_upgrade_stopped(old, expected, true)?;
        self.assert_force_group_current(&group_proof)?;
        self.stop_takeover
            .as_mut()
            .expect("original takeover")
            .current()?;
        need(
            native::PrivateFileStamp::of(&fs::symlink_metadata(&path)?) == stamp
                && fs::symlink_metadata(&path)?.gid() == group
                && native::PrivateFileStamp::of(&fs::symlink_metadata(&barrier.0)?) == barrier.1,
            "NATIVE_SERVICE_STOP_PENDING_CHANGED",
        )?;
        let from = self.open_directory(&self.folder())?;
        let to = self.open_directory(&history)?;
        self.attempted = true;
        let result: Result<()> = (|| {
            native::retain_stopped_service_pending(&self.files[from], &self.files[to])?;
            let archived = history.join("previous-stop-pending");
            let actual = native::PrivateFileStamp::of(&self.files[original].metadata()?);
            need(
                actual.same_renamed_file(&stamp)
                    && native::PrivateFileStamp::of(&fs::symlink_metadata(&archived)?) == actual
                    && fs::symlink_metadata(&archived)?.gid() == group,
                "NATIVE_SERVICE_STOP_ARCHIVE_CHANGED",
            )?;
            need(
                self.read_private(&archived)?.as_bytes()
                    == pending_bytes(&WorkerServiceAction::Stop),
                "NATIVE_SERVICE_STOP_ARCHIVE_CHANGED",
            )?;
            self.stop_takeover
                .as_mut()
                .expect("original takeover")
                .archive = Some((archived, actual, group));
            self.files[from].sync_all()?;
            self.files[to].sync_all()?;
            need(
                native::PrivateFileStamp::of(&fs::symlink_metadata(&barrier.0)?) == barrier.1,
                "NATIVE_SERVICE_STOP_BARRIER_CHANGED",
            )?;
            Ok(())
        })();
        if result.is_err() {
            self.uncertain = true;
        }
        result?;
        Ok(Some(history))
    }
    fn stop_pending_barrier(
        &mut self,
        origin: &StopOrigin<'_>,
    ) -> Result<(PathBuf, native::PrivateFileStamp)> {
        for name in ["native-failure", "native-running"] {
            let path = self.folder().join(name);
            match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
                Ok(metadata) => {
                    private(&path, false)?;
                    return Ok((path, native::PrivateFileStamp::of(&metadata)));
                }
            }
        }
        self.publish_stop_recovery_denial(origin)
    }
    fn assert_stop_origin(&mut self, origin: &StopOrigin<'_>) -> Result<()> {
        self.assert_upgrade_stopped(origin.old, origin.expected, true)?;
        self.assert_force_group_current(origin.stopped)?;
        self.stop_takeover
            .as_mut()
            .expect("same original takeover")
            .current()?;
        need(
            self.source_snapshot()?.raw == origin.source.raw,
            "NATIVE_SERVICE_UPGRADE_SOURCE_CHANGED",
        )?;
        need(
            native::PrivateFileStamp::of(&fs::symlink_metadata(origin.pending)?) == *origin.stamp
                && fs::symlink_metadata(origin.pending)?.gid() == origin.group
                && native::PrivateFileStamp::of(&self.files[origin.original].metadata()?)
                    == *origin.stamp,
            "NATIVE_SERVICE_STOP_PENDING_CHANGED",
        )
    }
    fn publish_stop_recovery_denial(
        &mut self,
        origin: &StopOrigin<'_>,
    ) -> Result<(PathBuf, native::PrivateFileStamp)> {
        need(
            !self.uncertain,
            "NATIVE_SERVICE_STOP_RECOVERY_ALREADY_UNCONFIRMED",
        )?;
        self.assert_stop_origin(origin)?;
        let folder = self.folder();
        let directory = self.open_directory(&folder)?;
        let identity = native::private_goal::identity(&self.files[directory].metadata()?);
        self.assert_stop_origin(origin)?;
        need(
            native::private_goal::identity(&fs::symlink_metadata(&folder)?) == identity,
            "NATIVE_SERVICE_STOP_RECOVERY_DIRECTORY_CHANGED",
        )?;
        let (path, stamp) = self.write_stop_recovery_denial(directory, &folder)?;
        self.assert_stop_origin(origin)?;
        need(
            native::private_goal::identity(&self.files[directory].metadata()?) == identity
                && native::private_goal::identity(&fs::symlink_metadata(&folder)?) == identity
                && native::PrivateFileStamp::of(&fs::symlink_metadata(&path)?) == stamp,
            "NATIVE_SERVICE_STOP_RECOVERY_DENIAL_CHANGED",
        )?;
        // This new publication is known. The old STOP remains UNKNOWN, both
        // names deny startup, and original checked closure still follows.
        self.uncertain = false;
        Ok((path, stamp))
    }
    fn write_stop_recovery_denial(
        &mut self,
        directory: usize,
        folder: &Path,
    ) -> Result<(PathBuf, native::PrivateFileStamp)> {
        self.attempted = true;
        self.uncertain = true;
        let writer = native::create_policy_temporary(
            &self.files[directory],
            std::ffi::OsStr::new("native-failure"),
        )?;
        self.files.push(writer);
        let writer = self.files.len() - 1;
        self.files[writer].write_all(RECOVERY_DENIAL)?;
        self.files[writer].sync_all()?;
        self.files[directory].sync_all()?;
        let path = folder.join("native-failure");
        private(&path, false)?;
        let stamp = native::PrivateFileStamp::of(&self.files[writer].metadata()?);
        need(
            native::PrivateFileStamp::of(&fs::symlink_metadata(&path)?) == stamp
                && self.read_private(&path)?.as_bytes() == RECOVERY_DENIAL,
            "NATIVE_SERVICE_STOP_RECOVERY_DENIAL_CHANGED",
        )?;
        Ok((path, stamp))
    }
    #[cfg(test)]
    pub(in crate::worker_service) fn stop_recovery_denial_for_test(
        &mut self,
    ) -> Result<(PathBuf, native::PrivateFileStamp)> {
        let folder = self.folder();
        let directory = self.open_directory(&folder)?;
        self.write_stop_recovery_denial(directory, &folder)
    }
}
