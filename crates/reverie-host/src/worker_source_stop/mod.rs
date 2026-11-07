//! Move-only ORIGINAL source stop owner, retained by the installing SourceRecord.
//! Actual resource custody and fixed native observations are not API authority.
//! There is no separate Runtime source registry or caller-selected command.
mod call;
mod error;
mod stop;
use crate::{
    captured_client::CapturedCall, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime, worker_storage::LaunchStorage,
};
pub use error::SourceStopError;
use error::{Result, need};
use reverie_contracts::{
    worker_config::EffectiveWorkerConfig,
    worker_source_stop::{
        SourceStopDataError, SourceStopInspection, SourceStopMetadata, SourceStopName,
    },
};
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Held,
    Inspecting,
    Policy,
    Stopping,
    Stopped,
    Closing,
    Failed,
    Closed,
}
/// Minted only by moving the actual source resource into this fixed purpose.
/// Unknown calls and their exact resource owner survive local call settlement.
#[must_use = "retain original source and its real pending calls until checked reconciliation"]
pub struct OriginalSourceStop {
    origin: Arc<InstalledWorkerEngine>,
    storage: Option<Box<LaunchStorage>>,
    name: SourceStopName,
    phase: Phase,
    deadline: Option<Instant>,
    inspection: Option<SourceStopInspection>,
    metadata: Option<SourceStopMetadata>,
    original_start: Option<String>,
    pending: Option<CapturedCall>,
    failure: Option<Arc<SourceStopError>>,
}
#[must_use = "retain the returned actual box after refused source transition"]
pub struct SourceStopRetainFailure {
    storage: Box<LaunchStorage>,
    error: SourceStopError,
}
impl SourceStopRetainFailure {
    pub fn into_parts(self: Box<Self>) -> (Box<LaunchStorage>, SourceStopError) {
        (self.storage, self.error)
    }
}
impl WorkerRuntime {
    /// Installing composition supplies the real held source, never a wire path,
    /// CID or JSON permission. Name/baseline are DATA, not an effect grant.
    pub fn retain_original_source_stop(
        &self,
        storage: Box<LaunchStorage>,
        name: SourceStopName,
        current: &EffectiveWorkerConfig,
        deadline: Option<Instant>,
    ) -> std::result::Result<OriginalSourceStop, Box<SourceStopRetainFailure>> {
        if let Err(error) = storage.assert_binding(self, current, storage.paths().session()) {
            return Err(Box::new(SourceStopRetainFailure {
                storage,
                error: SourceStopError::Resource(error),
            }));
        }
        if storage.ownership_kind() != crate::worker_storage::StorageOwnershipKind::HeldLease {
            return Err(Box::new(SourceStopRetainFailure {
                storage,
                error: SourceStopError::Refused("RESOURCE_SOURCE_EMPLOYEE_LEASE_REQUIRED"),
            }));
        }
        Ok(OriginalSourceStop {
            origin: self.installed_engine().clone(),
            storage: Some(storage),
            name,
            phase: Phase::Held,
            deadline,
            inspection: None,
            metadata: None,
            original_start: None,
            pending: None,
            failure: None,
        })
    }
}
impl OriginalSourceStop {
    pub fn policy_session(&self) -> &reverie_core::ids::ProfileSessionId {
        self.name.session()
    }
    pub fn failure(&self) -> Option<&Arc<SourceStopError>> {
        self.failure.as_ref()
    }
    fn bound(&self, runtime: &WorkerRuntime) -> Result<()> {
        need(
            Arc::ptr_eq(&self.origin, runtime.installed_engine()),
            "RESOURCE_SOURCE_STOP_RUNTIME_CHANGED",
        )
    }
    fn finish(&mut self, result: Result<()>, next: Phase) -> Result<()> {
        match result {
            Ok(()) => {
                self.phase = next;
                Ok(())
            }
            Err(error) => {
                self.phase = Phase::Failed;
                let error = Arc::new(error);
                self.failure = Some(error.clone());
                Err(SourceStopError::Recorded(error))
            }
        }
    }
    /// Check only this owner's actual captured native work. It cannot close a
    /// lease, resume an attempted stop or establish whole-service settlement.
    pub fn settle_native(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.bound(runtime)?;
        if let Some(call) = &self.pending {
            self.origin
                .engine
                .client
                .settle_call(
                    call,
                    self.origin
                        .stop_deadline()
                        .map_or(end, |stop| end.min(stop)),
                )
                .map_err(|error| SourceStopError::Engine(error.into()))?;
            self.pending = None;
        }
        Ok(())
    }
    /// Only a known native stopped phase can attempt this actual resource close.
    /// Application must first requalify its SAME claim and inventory every actual
    /// producer. This confirms local consumption, never capacity/global release.
    pub fn close_stopped_resource(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.bound(runtime)?;
        need(
            self.phase == Phase::Stopped,
            "RESOURCE_SOURCE_STOP_NOT_CONFIRMED",
        )?;
        // Latch the actual close attempt before settlement too. A later local
        // cleanup cannot renew this attempt or retry a consumed descriptor.
        self.phase = Phase::Closing;
        if let Err(error) = self.settle_native(runtime, end) {
            return self.finish(Err(error), Phase::Closed);
        }
        let owner = self.storage.take().expect("actual source resource");
        match owner.close(end) {
            Ok(()) => {
                self.phase = Phase::Closed;
                Ok(())
            }
            Err(failure) => {
                let (owner, cause) = failure.into_parts();
                self.storage = Some(Box::new(owner));
                self.finish(Err(SourceStopError::Resource(cause)), Phase::Closed)
            }
        }
    }
}
impl Drop for OriginalSourceStop {
    fn drop(&mut self) {
        // This is only process-lifetime quarantine, not a second active Runtime
        // registry or durable death fence. Existing STARTING/attempt readers
        // remain the authoritative restart/reconciliation obligation.
        type Abandoned = (
            Arc<InstalledWorkerEngine>,
            Box<LaunchStorage>,
            Option<CapturedCall>,
            Option<Arc<SourceStopError>>,
        );
        static OWNERS: OnceLock<Mutex<Vec<Abandoned>>> = OnceLock::new();
        if let Some(storage) = self.storage.take() {
            OWNERS
                .get_or_init(Mutex::default)
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push((
                    self.origin.clone(),
                    storage,
                    self.pending.take(),
                    self.failure.take(),
                ));
        }
    }
}
