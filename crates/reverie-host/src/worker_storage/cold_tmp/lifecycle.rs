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
    Retained(super::retained::ready::Ready),
    Finishing(super::retained::ready::Ready),
    Awaiting(Awaiting),
    Committed,
}
struct Awaiting {
    ready: super::retained::ready::Ready,
    native: crate::worker_laptop::cold_confirm::Confirmed,
    end: Instant,
}
#[derive(Default)]
pub(in crate::worker_storage) struct Lifecycle {
    phase: Phase,
    admission: Admission,
}
impl Lifecycle {
    pub(in crate::worker_storage) fn require_unattempted(&self) -> OwnerResult<()> {
        if matches!(self.phase, Phase::Untouched) {
            Ok(())
        } else {
            Err(StorageOwnerError::Refused(
                "WORKER_COLD_ATTEMPT_ALREADY_CONSUMED",
            ))
        }
    }
    pub(in crate::worker_storage) fn native_target(&self) -> OwnerResult<(Key, PosixPath)> {
        let ready = match &self.phase {
            Phase::Retained(ready) | Phase::Finishing(ready) => ready,
            Phase::Awaiting(value) => &value.ready,
            _ => {
                return Err(StorageOwnerError::Refused(
                    "WORKER_COLD_RETAINED_PREPARATION_REQUIRED",
                ));
            }
        };
        Ok((ready.new, ready.envelope.parent()))
    }
    pub(in crate::worker_storage) fn begin_commit(
        &mut self,
        storage: &LaunchStorage,
        source: &EffectiveWorkerConfig,
        native: &crate::worker_laptop::cold_confirm::Confirmed,
        supplied: Instant,
    ) -> OwnerResult<()> {
        if !matches!(self.phase, Phase::Retained(_)) {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_RETAINED_COMMIT_PHASE",
            ));
        }
        let Phase::Retained(ready) = std::mem::replace(&mut self.phase, Phase::Attempted) else {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_RETAINED_COMMIT_PHASE",
            ));
        };
        let end = (Instant::now() + std::time::Duration::from_secs(30)).min(supplied);
        let result = (|| {
            ready.require_prepared(storage, source, end)?;
            if !storage.matches_cold_confirmation(native) {
                return Err(StorageOwnerError::Refused(
                    "WORKER_COLD_NATIVE_OWNER_CHANGED",
                ));
            }
            super::retained::finish::publish(&ready, native, end)
        })();
        self.phase = if result.is_ok() {
            Phase::Awaiting(Awaiting {
                ready,
                native: native.clone(),
                end,
            })
        } else {
            Phase::Finishing(ready)
        };
        result
    }
    pub(in crate::worker_storage) fn release(
        &mut self,
        storage: &LaunchStorage,
        source: &EffectiveWorkerConfig,
        native: &crate::worker_laptop::cold_confirm::Confirmed,
        end: Instant,
    ) -> OwnerResult<()> {
        if !matches!(self.phase, Phase::Awaiting(_)) {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_RETAINED_RELEASE_PHASE",
            ));
        }
        let Phase::Awaiting(value) = std::mem::replace(&mut self.phase, Phase::Attempted) else {
            return Err(StorageOwnerError::Refused(
                "WORKER_COLD_RETAINED_RELEASE_PHASE",
            ));
        };
        let result = (|| {
            let end = end.min(value.end);
            value.ready.require_prepared(storage, source, end)?;
            if !value.native.same(native) || !storage.matches_cold_confirmation(native) {
                return Err(StorageOwnerError::Refused(
                    "WORKER_COLD_NATIVE_BINDING_CHANGED",
                ));
            }
            let config = Configuration::capture(source).map_err(StorageOwnerError::Storage)?;
            let original = super::super::temporary::path_text(&config, storage.paths())
                .map_err(StorageOwnerError::Storage)?;
            let pending = native::python_path(&original.home().parent().codepoints())
                .map_err(StorageOwnerError::Path)?
                .join(super::retained::ready::PENDING);
            value
                .ready
                .verify(end)
                .map_err(StorageOwnerError::Storage)?;
            // LAST syscall: no native query, close, flush, clock or owner read
            // follows this acknowledged release. Only in-memory phase moves.
            std::fs::remove_file(pending).map_err(StorageOwnerError::Path)
        })();
        self.phase = if result.is_ok() {
            Phase::Committed
        } else {
            Phase::Finishing(value.ready)
        };
        result.map_err(|error| StorageOwnerError::ColdUnconfirmed(Box::new(error)))
    }
    pub(in crate::worker_storage) fn retain(
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
        let ready =
            super::retained::prepare::run(runtime, storage, plan, &mut self.admission, end)?;
        self.phase = Phase::Retained(ready);
        Ok(())
    }
    pub(in crate::worker_storage) fn require_current(
        &self,
        storage: &LaunchStorage,
    ) -> OwnerResult<()> {
        match &self.phase {
            Phase::Retained(ready) => ready.require_prepared(
                storage,
                &ready.source,
                Instant::now() + std::time::Duration::from_secs(30),
            ),
            Phase::Awaiting(value) => {
                value
                    .ready
                    .require_prepared(storage, &value.ready.source, value.end)
            }
            Phase::Finishing(_) => Err(StorageOwnerError::Refused(
                "WORKER_COLD_RETAINED_UNCONFIRMED",
            )),
            _ => storage.require_no_cold_pending(),
        }
    }
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
        if policy.strategy() == ColdStrategy::RetainAndReplace {
            return match &self.phase {
                Phase::Retained(ready) => ready.require_prepared(
                    storage,
                    source,
                    Instant::now() + std::time::Duration::from_secs(30),
                ),
                Phase::Awaiting(value) => value.ready.require_prepared(storage, source, value.end),
                _ => Err(StorageOwnerError::Refused(
                    "WORKER_COLD_RETENTION_PREPARATION_REQUIRED",
                )),
            };
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
