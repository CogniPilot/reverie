//! Actual installing-service current configuration owner. Native admission,
//! lifecycle registry and effects remain private composition of this service;
//! a captured configuration is neither owner authorization nor a start grant.
mod creation;
mod storage;
use crate::{
    reservation_gate::{GateError, ReservationGate},
    reservation_observer::NativeObserver,
    worker_validation::ValidatedWorkerSnapshot,
};
pub use creation::CreationBudgetError;
use reverie_contracts::reservation_engine::ReservationConfiguration;
use reverie_core::{ids::ProfileSessionId, worker_laptop::WorkerContainerName};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
pub use storage::{StorageClaim, StorageReleaseFailure, StorageWorkflowError};
struct CurrentInstalled {
    snapshot: Arc<ValidatedWorkerSnapshot>,
    resources: Arc<ReservationConfiguration>,
}
impl CurrentInstalled {
    fn capture(snapshot: Arc<ValidatedWorkerSnapshot>) -> Self {
        Self {
            resources: Arc::new(ReservationConfiguration::capture(
                snapshot.configuration().clone(),
            )),
            snapshot,
        }
    }
}
struct LaptopRegistration {
    session: ProfileSessionId,
    name: WorkerContainerName,
}
/// Ordered real installing lifecycle state. No raw registry setter or public
/// registration constructor exists; native launch/recovery producers own it.
pub(crate) struct LaptopLifecycle<'a> {
    guard: MutexGuard<'a, Vec<LaptopRegistration>>,
}
impl LaptopLifecycle<'_> {
    pub(crate) fn entries(
        &self,
    ) -> impl Iterator<Item = (&ProfileSessionId, &WorkerContainerName)> {
        self.guard
            .iter()
            .map(|laptop| (&laptop.session, &laptop.name))
    }
}
pub(crate) struct InstalledWorker {
    current: RwLock<CurrentInstalled>,
    laptops: Mutex<Vec<LaptopRegistration>>,
}
impl InstalledWorker {
    #[cfg(test)]
    pub(crate) fn model_laptop(&self, session: ProfileSessionId) {
        let snapshot = self.snapshot().unwrap();
        let name = WorkerContainerName::for_session(snapshot.envelope().base(), &session);
        self.laptops
            .lock()
            .unwrap()
            .push(LaptopRegistration { session, name });
    }
    pub(crate) fn capture(snapshot: ValidatedWorkerSnapshot) -> Arc<Self> {
        Arc::new(Self {
            current: RwLock::new(CurrentInstalled::capture(Arc::new(snapshot))),
            laptops: Mutex::new(Vec::new()),
        })
    }
    pub(crate) fn lifecycle(&self) -> Result<LaptopLifecycle<'_>, GateError> {
        Ok(LaptopLifecycle {
            guard: self
                .laptops
                .lock()
                .map_err(|_| GateError::Refused("WORKER_BROKER_LIFECYCLE_UNAVAILABLE"))?,
        })
    }
    pub(crate) fn install_reloaded(
        &self,
        proof: crate::reservation_gate::InspectedReload,
        context: &mut crate::reservation_observer::ObservationContext,
    ) -> Result<(), GateError> {
        let (before, updated) = proof.into_snapshots();
        let next = context.with_applied_configuration(updated.configuration().clone());
        let installed = CurrentInstalled::capture(updated);
        let mut current = self
            .current
            .write()
            .map_err(|_| GateError::Refused("WORKER_BROKER_CURRENT_UNAVAILABLE"))?;
        if !Arc::ptr_eq(&current.snapshot, &before) {
            return Err(GateError::Refused("WORKER_RESOURCE_RELOAD_CHANGED"));
        }
        // No native I/O or fallible check between these two publications.
        *context = next;
        *current = installed;
        Ok(())
    }
    pub(crate) fn snapshot(&self) -> Result<Arc<ValidatedWorkerSnapshot>, GateError> {
        self.current
            .read()
            .map(|current| current.snapshot.clone())
            .map_err(|_| GateError::Refused("WORKER_BROKER_CURRENT_UNAVAILABLE"))
    }
    pub(crate) fn resources(&self) -> Result<Arc<ReservationConfiguration>, GateError> {
        self.current
            .read()
            .map(|current| current.resources.clone())
            .map_err(|_| GateError::Refused("WORKER_BROKER_CURRENT_UNAVAILABLE"))
    }
}
pub struct InstallingBroker {
    gate: ReservationGate,
    storage: Arc<storage::StorageRegistry>,
}
impl InstallingBroker {
    /// Trusted installing bootstrap; no wire-selected native engine or path.
    pub fn new(
        snapshot: ValidatedWorkerSnapshot,
        runtime: reverie_host::worker_runtime::WorkerRuntime,
    ) -> Result<Self, GateError> {
        let observer = NativeObserver::new(runtime.readonly());
        Ok(Self {
            gate: ReservationGate::new(snapshot, observer)?,
            storage: Arc::new(storage::StorageRegistry::new(runtime)),
        })
    }
    pub fn configuration(&self) -> Result<Arc<ValidatedWorkerSnapshot>, GateError> {
        self.gate.installed_snapshot()
    }
    pub fn resource_reservations(&self) -> &ReservationGate {
        &self.gate
    }
    pub fn reload_resources(&self) -> Result<(), GateError> {
        self.gate.reload_owner_configuration()
    }
    /// Current intent from the actual installed configuration; this observation
    /// is not API authorization, storage eligibility or a start permission.
    pub fn allowed(&self, session: &ProfileSessionId) -> Result<bool, GateError> {
        Ok(reverie_host::worker_intent::read_allowed(
            self.configuration()?.configuration(),
            session,
        )?)
    }

    /// Actual fixed-purpose storage acquisition. This retains resources only;
    /// it neither registers a laptop nor authorizes engine/start effects.
    pub fn claim_storage(
        &self,
        session: &ProfileSessionId,
    ) -> Result<StorageClaim, StorageWorkflowError> {
        self.storage
            .claim(self.configuration()?.configuration(), session)
    }
    pub fn launch_wait_binding(
        &self,
        session: &ProfileSessionId,
    ) -> Result<Option<reverie_contracts::storage_writers::LaunchWaitBinding>, StorageWorkflowError>
    {
        Ok(reverie_host::worker_storage::read_launch_wait_binding(
            self.configuration()?.configuration(),
            session,
        )?)
    }
    pub fn request_stop(&self) -> std::time::Instant {
        self.storage.runtime.request_stop()
    }
}
