//! Actual installing-service current configuration owner. Native admission,
//! lifecycle registry and effects remain private composition of this service;
//! a captured configuration is neither owner authorization nor a start grant.
mod bootstrap;
pub use bootstrap::{BootstrapSettlementError, BrokerBootstrapCause, BrokerBootstrapFailure};
#[cfg(test)]
mod bootstrap_tests;
mod creation;
mod gpu_access;
mod image_refresh;
mod launch;
mod lifecycle;
mod recovered;
mod service;
pub use service::{BrokerServiceStartup, BrokerStartupCause, BrokerStartupFailure};
pub(crate) mod source;
mod stop_admission;
mod storage;
pub(crate) use stop_admission::WorkerStopAdmission;
mod telemetry;
use crate::{
    reservation_gate::{GateError, ReservationGate},
    reservation_observer::NativeObserver,
    worker_validation::ValidatedWorkerSnapshot,
};
pub use creation::CreationBudgetError;
pub(crate) use image_refresh::LoadedLaunchImage;
pub use launch::{
    AdmittedWorkerLaunch, AllocationClosedCold, AllocationClosedReuse, ClassifiedWorkerLaunch,
    ColdLaunchFailure, ColdViewerFailure, ColdWorkerLaunch, ExistingColdTarget,
    InspectedWorkerLaunch, LaunchAdmissionFailure, LaunchPreparationFailure, PreparedReuseViewer,
    ReceivedWorkerLaunch, RestoredReuse, ReusableWorkerLaunch, ReuseFinalizationFailure,
    ReuseHandlerClosed, ReuseRelayError, ReuseRelayReturned, ReuseViewerFailure, ViewingCold,
    ViewingReuse, WorkerConnectionDispatch, WorkerDispatchError,
};
pub(crate) use lifecycle::LaptopLifecycle;
use lifecycle::LaptopState;
use recovered::{LaptopOwner, RecoveryOwners};
pub use recovered::{RecoveryError, RecoverySummary};
use reverie_contracts::reservation_engine::ReservationConfiguration;
use reverie_core::{ids::ProfileSessionId, worker_laptop::WorkerContainerName};
pub use source::SourceDraftError;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
pub use storage::{
    NetworkStorageError, NetworkStoragePreparation, NetworkStorageReclaimFailure,
    NetworkStorageRetainFailure, NetworkStorageReturned, NixStorageError, NixStoragePreparation,
    NixStorageReclaimFailure, NixStorageRetainFailure, NixStorageReturned,
    OwnedCreatePreparationError, ReplacementStopPreparation, ReplacementStopReclaimFailure,
    ReplacementStopRetainFailure, ReplacementStopReturned, StorageClaim, StorageReleaseFailure,
    StorageWorkflowError,
};
pub use telemetry::TelemetryCloseError;
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
    owner: LaptopOwner,
}
pub(crate) struct InstalledWorker {
    current: RwLock<CurrentInstalled>,
    laptops: Mutex<LaptopState>,
    #[cfg(test)]
    image_loaded_pause:
        Mutex<Option<crate::test_process::PausePoint<Arc<ValidatedWorkerSnapshot>>>>,
}
impl InstalledWorker {
    /// Read the current configuration and its same-installation binding under
    /// the publication lock order. The caller retains Gate state/context when
    /// it needs the full guard tuple; no I/O or transition authority is created.
    pub(crate) fn bound_resources(
        &self,
        binding: &RwLock<reverie_contracts::reservation_control::ControlBinding>,
    ) -> Result<
        (
            Arc<ReservationConfiguration>,
            reverie_contracts::reservation_control::ControlBinding,
        ),
        GateError,
    > {
        let current = self
            .current
            .read()
            .map_err(|_| GateError::Refused("WORKER_BROKER_CURRENT_UNAVAILABLE"))?;
        let binding = binding
            .read()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        Ok((current.resources.clone(), binding.clone()))
    }
    #[cfg(test)]
    pub(crate) fn model_laptop(&self, session: ProfileSessionId) {
        let snapshot = self.snapshot().unwrap();
        let name = WorkerContainerName::for_session(snapshot.envelope().base(), &session);
        self.laptops.lock().unwrap().push(LaptopRegistration {
            session,
            name,
            owner: LaptopOwner::Modeled,
        });
    }
    pub(crate) fn capture(snapshot: ValidatedWorkerSnapshot) -> Arc<Self> {
        Arc::new(Self {
            current: RwLock::new(CurrentInstalled::capture(Arc::new(snapshot))),
            laptops: Mutex::new(LaptopState::new()),
            #[cfg(test)]
            image_loaded_pause: Mutex::new(None),
        })
    }
    pub(crate) fn lifecycle(&self) -> Result<LaptopLifecycle<'_>, GateError> {
        Ok(LaptopLifecycle {
            owner: self,
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
    installed: Arc<InstalledWorker>,
    gate: Option<ReservationGate>,
    storage: Arc<storage::StorageRegistry>,
    telemetry: Arc<reverie_host::command_telemetry::CommandTelemetry>,
    reports: Arc<reverie_host::worker_reports::WorkerReportService>,
    recovery: Arc<RecoveryOwners>,
}
impl InstallingBroker {
    /// Trusted installing bootstrap; no wire-selected native engine or path.
    pub fn new(
        snapshot: ValidatedWorkerSnapshot,
        runtime: reverie_host::worker_runtime::WorkerRuntime,
    ) -> Result<Self, Box<BrokerBootstrapFailure>> {
        Self::bootstrap(snapshot, runtime)
    }
    pub(crate) fn command_telemetry(
        &self,
    ) -> &Arc<reverie_host::command_telemetry::CommandTelemetry> {
        &self.telemetry
    }
    pub fn configuration(&self) -> Result<Arc<ValidatedWorkerSnapshot>, GateError> {
        self.installed.snapshot()
    }
    /// Feature absence is not a no-op admission permit. Recheck the original
    /// durable marker/pending fence whenever an unreserved caller selects it.
    pub fn resource_reservations(&self) -> Result<Option<&ReservationGate>, GateError> {
        if self.gate.is_none()
            && reverie_host::reservation_control::prior_control_present(
                self.installed.resources()?.as_ref(),
            )?
        {
            return Err(GateError::Refused(
                "RESERVATION_INSTALL_REQUIRES_RECONCILIATION",
            ));
        }
        Ok(self.gate.as_ref())
    }
    pub fn reload_resources(&self) -> Result<(), GateError> {
        self.resource_reservations()?
            .ok_or(GateError::Refused("RESERVATION_NOT_CONFIGURED"))?
            .reload_owner_configuration()
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
