//! Actual reservation admission/control composition. This internal service is
//! not an HTTP authority or a process/start permit. Effect-owner cohorts remain
//! separate from the read-side admission dependencies.
mod admission;
mod claim;
mod draft;
mod error;
mod guard;
mod history;
mod host_jobs;
mod image_refresh;
mod launch;
mod observation;
mod preparation;
mod preparation_commit;
mod preparation_phase;
mod preparation_policy;
mod preparation_stage;
mod preparation_start;
pub use preparation_start::{ProtectedStartIntent, StartQualificationFacts};
mod profile_selection;
mod recovery;
mod reload;
mod terminal_claim;
#[cfg(test)]
pub(crate) mod tests;
use crate::{
    reservation_observer::{NativeObserver, ObservationContext, ObservedInventory, ObserverError},
    worker_validation::ValidatedWorkerSnapshot,
};
pub use admission::AdmissionBounds;
pub use draft::DraftPreview;
pub use error::GateError;
use error::{Result, finalized, need};
pub use history::HeadroomFacts;
pub use launch::OrdinaryLaunchAdmission;
pub use preparation::RetainedPreparation;
pub use preparation_phase::PreparationIntentFacts;
pub use preparation_stage::StagedPreparation;
pub use recovery::{NativeObservationState, RecoveryFacts, RecoveryObservation};
pub(crate) use reload::InspectedReload;
use reverie_contracts::{
    reservation_control::{ControlBinding, ControlDataError, domain_digest},
    reservation_engine::{EngineDataError, ReservationConfiguration},
    worker_validation::{WorkerValidationData, WorkerValidationError},
};
use reverie_core::operations::{JournalId, OperationScope};
use reverie_host::reservation_control::{self, AdmissionLock, ControlHostError, ImageHostError};
use reverie_store::operations::{JournalError, OperationStore, OperationView, ScopeGuard};
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, Weak},
    thread::ThreadId,
    time::Instant,
};

pub struct ReservationGate {
    inner: Arc<Inner>,
}
struct Inner {
    installed: Arc<crate::installing_broker::InstalledWorker>,
    source_path: Option<PathBuf>,
    binding: ControlBinding,
    scope: OperationScope,
    observer: NativeObserver,
    option: reverie_core::worker_options::ReservationOption,
    identity: reverie_store::storage_identity::StorageIdentityConfig,
    state: Mutex<State>,
    changed: Condvar,
    #[cfg(test)]
    entry_capture_pause: Mutex<Option<crate::test_process::PausePoint<ObservationContext>>>,
}
#[derive(Default)]
struct State {
    active: Option<Arc<Active>>,
    entering: Option<admission::Entering>,
}
struct Active {
    thread: ThreadId,
    process: u32,
    lock: Mutex<AdmissionLock>,
    context: Mutex<ObservationContext>,
    policy_ack: Mutex<Option<Arc<preparation_policy::PolicyAckFence>>>,
    deadline: Mutex<Option<Instant>>,
}
impl ReservationGate {
    /// Stop/settle the same persistent owned metadata-client context before an
    /// installing service acknowledges shutdown. Cleanup never turns a failed
    /// observation into success or grants worker/process effects.
    pub fn cancellation(&self) -> reverie_host::engine_metadata::CancellationToken {
        self.inner.observer.cancellation()
    }
    pub fn settle_owned(&self, end: Instant) -> Result<()> {
        Ok(self.inner.observer.settle_owned(end)?)
    }
    /// Installing-service input, never a request-selected Source/config path.
    /// The full existing validator must succeed before this constructor exists.
    pub fn new(snapshot: ValidatedWorkerSnapshot, observer: NativeObserver) -> Result<Self> {
        let installed = crate::installing_broker::InstalledWorker::capture(snapshot);
        Self::from_installed(installed, observer)
    }
    pub(crate) fn from_installed(
        installed: Arc<crate::installing_broker::InstalledWorker>,
        observer: NativeObserver,
    ) -> Result<Self> {
        let snapshot = installed.snapshot()?;
        let option = WorkerValidationData::new(snapshot.configuration())
            .reservation()?
            .ok_or(GateError::Refused("RESERVATION_POLICY_REMOVED"))?;
        let scope = OperationScope {
            company_id: option.company().clone(),
            owner_scope_digest: option.owner_scope().clone(),
        };
        let source_path = snapshot.source_path().map(std::path::Path::to_owned);
        let resources = reverie_contracts::resource_config::ResourceConfiguration::capture(
            snapshot.configuration().clone(),
        )?;
        let identity =
            reverie_store::storage_identity::StorageIdentityConfig::capture_worker_settings(
                &resources.identity_settings()?,
            );
        let config = ReservationConfiguration::capture(snapshot.configuration().clone());
        need(
            !reservation_control::pending_present(&config)?,
            "RESERVATION_INSTALL_REQUIRES_RECONCILIATION",
        )?;
        let binding = ControlBinding::from_metadata(
            &reservation_control::read_marker(&config)?,
            config.configuration(),
        )?;
        Ok(Self {
            inner: Arc::new(Inner {
                installed,
                source_path,
                binding,
                scope,
                observer,
                option,
                identity,
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
                #[cfg(test)]
                entry_capture_pause: Mutex::new(None),
            }),
        })
    }
    /// Fixed readonly lookup with actual admission, canonical journal locking,
    /// checked store close and the admission's final native/image guard.
    pub fn inspect(&self, key: &JournalId) -> Result<Option<OperationView>> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let result = (|| {
            let store = self.inner.store()?;
            let result = store.lookup(&self.inner.scope, key).map_err(Into::into);
            finalized(result, store.close().map_err(Into::into))
        })();
        admission.conclude(result)
    }
    pub fn observe(
        &self,
        employee: &reverie_core::ids::ProfileEmployeeId,
    ) -> Result<reverie_contracts::reservation_observation::ReservationObservation> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let result = self
            .inner
            .observe(&self.inner.scope, self.inner.option.pool(), employee);
        admission.conclude(result)
    }
    /// Fixed read-only INSTALL budget observation under actual admission. This
    /// qualifies retained old-source assumptions, never a candidate or permit.
    pub fn check_headroom(&self) -> Result<HeadroomFacts> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let result = self.inner.check_headroom();
        admission.conclude(result)
    }
}
impl Inner {
    fn config(&self) -> Result<Arc<ReservationConfiguration>> {
        self.installed.resources()
    }
}
