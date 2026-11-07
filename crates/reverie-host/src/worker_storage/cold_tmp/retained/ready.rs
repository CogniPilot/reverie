//! Private actual preparation outcome; no reader/JSON/status constructor.
//! All temporary descriptors/locks are finalized before this owner is returned.
use super::super::*;
use reverie_contracts::worker_cold_tmp::{
    ColdConfiguration, ColdStrategy, ReferenceReport, RetainedRecordEpoch, RetainedRecordFresh,
    RetainedRecordIdentity, RetainedReservationUntil,
};
use reverie_core::ids::NativeOperationId;
pub(in crate::worker_storage::cold_tmp) const PENDING: &str = "cold-tmp-cleanup.pending.json";
pub(in crate::worker_storage::cold_tmp) struct Ready {
    pub(super) attempt: NativeOperationId,
    pub(in crate::worker_storage::cold_tmp) source: EffectiveWorkerConfig,
    pub(super) paths: StoragePaths,
    pub(super) old: Key,
    pub(in crate::worker_storage::cold_tmp) new: Key,
    pub(in crate::worker_storage::cold_tmp) envelope: PosixPath,
    pub(super) control: Stamp,
    pub(super) envelope_stamp: Stamp,
    pub(super) identity_stamp: Stamp,
    pub(super) keep: Stamp,
    pub(super) pending: Stamp,
    pub(super) digest: String,
    pub(super) prepared: [u8; 32],
    pub(super) reservation: RetainedReservationUntil,
    pub(super) before: ReferenceReport,
    pub(super) after: ReferenceReport,
}
impl Ready {
    pub(super) fn epoch(&self) -> RetainedRecordEpoch<'_> {
        RetainedRecordEpoch {
            identity: RetainedRecordIdentity {
                attempt: &self.attempt,
                identity: self.paths.identity(),
                session: self.paths.session(),
                owner: self.paths.owner().as_ref(),
            },
            envelope: &self.envelope,
            old: self.old,
        }
    }
    pub(super) fn record(&self) -> RetainedRecordFresh<'_> {
        RetainedRecordFresh {
            epoch: self.epoch(),
            new: self.new,
            reservation_until: &self.reservation,
        }
    }
    pub(in crate::worker_storage::cold_tmp) fn require_prepared(
        &self,
        storage: &LaunchStorage,
        source: &EffectiveWorkerConfig,
        end: Instant,
    ) -> std::result::Result<(), StorageOwnerError> {
        let policy = ColdConfiguration::capture(source)
            .map_err(StorageOwnerError::ColdData)?
            .ok_or(StorageOwnerError::Refused("WORKER_COLD_POLICY_REQUIRED"))?;
        if policy.strategy() != ColdStrategy::RetainAndReplace
            || policy.digest() != self.digest
            || storage.paths() != &self.paths
        {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_RETAINED_BINDING_CHANGED",
            ));
        }
        storage.check_resource_current()?;
        self.verify(end).map_err(StorageOwnerError::Storage)
    }
    pub(in crate::worker_storage::cold_tmp) fn verify(&self, end: Instant) -> Result<()> {
        check(end)?;
        let config = Configuration::capture(&self.source)?;
        let original = super::super::super::temporary::path_text(&config, &self.paths)?;
        let control = original.home().parent();
        let tmp = original.scratch().join(&PosixPath::from_scalar_text("tmp"));
        let scratch = PosixPath::try_new(config.settings.scratch_root().codepoints())
            .expect("settings points");
        let kind = if self.paths.employee().is_some() {
            "employee"
        } else {
            "session"
        };
        let identity = scratch
            .join(&PosixPath::from_scalar_text(".reverie-retained-tmp"))
            .join(&PosixPath::from_scalar_text(&format!(
                "{kind}-{}",
                self.paths.identity()
            )));
        need(self.envelope.parent() == identity, StorageFault::ColdTree)?;
        directory(&control, &self.control)?;
        directory(&self.envelope, &self.envelope_stamp)?;
        directory(&identity, &self.identity_stamp)?;
        let old = stat(&self.envelope.join(&PosixPath::from_scalar_text("data")))?;
        need(
            old.directory()
                && old.key == self.old
                && old.uid == config.uid()
                && old.mode & 0o7777 == 0o700,
            StorageFault::ColdTree,
        )?;
        let fresh = stat(&tmp)?;
        need(
            fresh.directory() && fresh.key == self.new && fresh.mode & 0o7777 == 0o700,
            StorageFault::ColdTree,
        )?;
        let keep = stat(&self.envelope.join(&PosixPath::from_scalar_text(".keep")))?;
        need(
            keep == self.keep && keep.mode & libc::S_IFMT == libc::S_IFREG,
            StorageFault::ColdPreservation,
        )?;
        let pending = stat(&control.join(&PosixPath::from_scalar_text(PENDING)))?;
        need(pending == self.pending, StorageFault::ColdTree)?;
        check(end)
    }
    pub(super) fn prepared_name(&self) -> OsString {
        OsString::from(format!(
            "cold-tmp-retained-ready-{}.json",
            self.attempt.as_str()
        ))
    }
}
fn directory(path: &PosixPath, expected: &Stamp) -> Result<()> {
    need(
        expected.same_directory(&stat(path)?),
        StorageFault::ColdTree,
    )
}
fn stat(path: &PosixPath) -> Result<Stamp> {
    need(
        native::resolve_strict_text(&path.codepoints())? == *path,
        StorageFault::CanonicalPath,
    )?;
    Ok(Stamp::capture(&std::fs::symlink_metadata(
        native::python_path(&path.codepoints())?,
    )?))
}
