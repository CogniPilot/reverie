//! One non-clonable cold phase carried by the original LaunchStorage as it
//! moves Nix→Laptop. No status/config/path constructor can manufacture success.
use super::*;
use super::{
    admission::Admission,
    clear::{self, Cleared},
};
use crate::{
    installed_worker_engine::InstalledWorkerEngine, worker_launch::ObservedCreatePlan,
    worker_runtime::WorkerRuntime,
};
use reverie_contracts::worker_cold_tmp::{ColdConfiguration, ColdStrategy};
type OwnerResult<T> = std::result::Result<T, StorageOwnerError>;
#[derive(Default)]
enum Phase {
    #[default]
    Untouched,
    Attempted,
    Cleared(Cleared),
}
#[derive(Default)]
pub(in crate::worker_storage) struct Lifecycle {
    phase: Phase,
    admission: Admission,
}
impl Lifecycle {
    pub(in crate::worker_storage) fn clear(
        &mut self,
        runtime: &WorkerRuntime,
        storage: &mut LaunchStorage,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> OwnerResult<()> {
        if !matches!(self.phase, Phase::Untouched) {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_ATTEMPT_ALREADY_CONSUMED",
            ));
        }
        self.phase = Phase::Attempted;
        let report = clear::run(runtime, storage, plan, &mut self.admission, end)?;
        self.phase = Phase::Cleared(report);
        Ok(())
    }
    pub(in crate::worker_storage) fn require_prepared(
        &self,
        source: &EffectiveWorkerConfig,
        storage: &LaunchStorage,
    ) -> OwnerResult<()> {
        let policy = ColdConfiguration::capture(source).map_err(StorageOwnerError::ColdData)?;
        let Some(policy) = policy else {
            return storage.require_no_cold_pending();
        };
        if policy.strategy() != ColdStrategy::Clear {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_RETENTION_PREPARATION_REQUIRED",
            ));
        }
        let Phase::Cleared(report) = &self.phase else {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_CLEAR_PREPARATION_REQUIRED",
            ));
        };
        if report.digest != policy.digest() {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_CONFIGURATION_CHANGED",
            ));
        }
        // Retain the actual full report, not only an enabled/ready bit. Its
        // count is bounded by the transaction that minted it; keys bind TMP.
        need(report.entries <= MAX_ENTRIES, StorageFault::ColdBound)
            .map_err(StorageOwnerError::Storage)?;
        let config = Configuration::capture(source).map_err(StorageOwnerError::Storage)?;
        let original = super::super::temporary::path_text(&config, storage.paths())
            .map_err(StorageOwnerError::Storage)?;
        let target = original.scratch().join(&PosixPath::from_scalar_text("tmp"));
        let actual =
            native::resolve_strict_text(&target.codepoints()).map_err(StorageOwnerError::Path)?;
        if actual != target {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_TMP_BINDING_CHANGED",
            ));
        }
        let info = std::fs::symlink_metadata(
            native::python_path(&target.codepoints()).map_err(StorageOwnerError::Path)?,
        )
        .map_err(StorageOwnerError::Path)?;
        if !info.is_dir() || (info.dev(), info.ino()) != report.key || info.mode() & 0o7777 != 0o700
        {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_TMP_BINDING_CHANGED",
            ));
        }
        storage.require_no_cold_pending()
    }
    pub(in crate::worker_storage) fn settle(
        &mut self,
        engine: &InstalledWorkerEngine,
        end: Instant,
    ) -> OwnerResult<()> {
        self.admission.settle(engine, end)
    }
}
