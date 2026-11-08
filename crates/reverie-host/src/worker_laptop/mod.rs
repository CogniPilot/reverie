//! Fixed laptop effects retain actual Nix/storage/Office owners before the
//! first native client. InstallingBroker still owns admission and authorization.
mod abort_held;
mod call_budget;
pub use abort_held::HeldLaptopNetworkReturn;
mod cleanup;
mod cold;
pub(crate) mod cold_confirm;
mod cold_prepare;
mod connection;
pub use cold_prepare::{ColdPreparation, PreparedColdTemporary};
mod create;
mod direct_finalization;
mod error;
mod existing_viewer;
pub(crate) mod final_storage;
mod guard;
mod handler_settlement;
mod memory;
mod network;
mod pane;
mod perf;
mod protected;
mod publication;
pub use protected::{
    ProtectedCliObservation, ProtectedCreatedObservation, ProtectedMemoryObservation,
};
mod request_cleanup;
mod start;
mod started_finalization;
mod started_transfer;
pub use started_finalization::StartedStorageFinalizer;
mod storage;
mod storage_cleanup;
pub use started_transfer::{
    StartedControlStopTransferred, StartedOrdinaryStopTransferFailure,
    StartedOrdinaryStopTransferred, StartedReplacementStopTransferFailure,
    StartedReplacementStopTransferred,
};
mod started_source;
pub use started_source::{
    StartedLaptopSource, StartedSourceStopTransferred, StartedSourceStorageBorrow,
    StartedSourceStorageObservation, StoppedStartedSourceReturned,
};
pub use storage::StartedStorageBorrow;
mod created_receipt;
pub use created_receipt::CreatedReceiptObservation;
mod created_finalization;
pub use created_finalization::{CreatedStorageObservation, StoppedCreatedReturned};
#[cfg(test)]
mod tests;
mod viewer;
use crate::{
    installed_worker_engine::InstalledWorkerEngine,
    office::OfficePhone,
    worker_launch::ObservedCreatePlan,
    worker_nix::{NixReturned, NixWorkflow},
    worker_runtime::WorkerRuntime,
};
pub use cleanup::{CreatedCleanup, StoppedCreatedLaptop};
pub use cold::{ColdCommit, ColdCommitted};
pub use create::{CreatedLaptop, LaptopCreation};
pub use direct_finalization::{
    DirectStorageFinalizer, DirectStorageObservation, DirectStorageRetainFailure,
};
pub use error::{CreateTelemetryFailure, LaptopError, TelemetryCause};
use error::{Result, finalized, need};
pub use existing_viewer::{
    ExistingRelayRetainFailure, ExistingRelayReturned, ExistingStorageObservation, ExistingViewer,
    ExistingViewerReceiptObservation, ExistingViewerRetainFailure, ExistingViewerReturned,
    ExistingViewerStart, StartedRelayTransferFailure, StartedRelayTransferred,
};
pub use guard::{NixGuardRelease, NixReleasedPane};
pub use memory::{
    ConfiguredMemory, MemoryConfiguration, StartedMemoryPolicy, StartedMemoryReadback,
    WorkerMemoryBegin, WorkerMemoryEffect,
};
pub use pane::{PaneStart, StartedPane};
use reverie_contracts::worker_launch::WorkerRequest;
pub use start::{ContainerStart, StartedContainer};
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
pub(crate) use viewer::ViewerJob;
pub use viewer::{ViewerSession, ViewerStart};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaptopNetworkProgress {
    Ready,
    Rejected,
    Retained,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Held,
    Running,
    Known,
    Retained,
    Cleaning,
    FinalizingStarted,
    Stopped,
    CleanupRetained,
    Consumed,
}
struct Resources {
    nix: guard::NixOwnership,
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    office: OfficePhone,
    connection: Option<crate::worker_reports::terminal::RelayIdentity>,
}
impl Resources {
    fn held_nix(&self) -> Result<&NixReturned> {
        self.nix.held()
    }
    fn storage(&self) -> &crate::worker_storage::LaunchStorage {
        self.nix.storage()
    }
}
struct Inputs {
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    office: OfficePhone,
}
struct Record {
    source_attachment: Option<started_source::Attachment>,
    finalization: created_finalization::StorageCheck,
    cold: cold_prepare::Stage,
    resources: Option<Resources>,
    phase: Phase,
    outcome: Option<std::result::Result<(), Arc<LaptopError>>>,
    pending: Option<crate::captured_client::CapturedCall>,
    unknown: bool,
    settlement: Option<crate::engine_metadata::EngineError>,
    creation: Option<create::Creation>,
    cleanup: Option<cleanup::Cleanup>,
    viewer: Option<Arc<viewer::ViewerJob>>,
}
impl Record {
    /// Cached local cleanup must not revoke another actual consuming purpose.
    /// Refuse before changing phase, returning cached success or native effects.
    fn begin_cleanup(&mut self) -> Result<()> {
        need(
            self.phase != Phase::FinalizingStarted,
            "WORKER_STARTED_FINAL_STORAGE_RETAINED",
        )?;
        if !matches!(self.phase, Phase::Stopped | Phase::CleanupRetained) {
            self.phase = Phase::Cleaning;
        }
        Ok(())
    }
    fn resources(&self) -> &Resources {
        self.resources.as_ref().expect("actual unreclaimed owners")
    }
    fn progress(&self) -> LaptopNetworkProgress {
        if self.phase != Phase::Known {
            return LaptopNetworkProgress::Retained;
        }
        if self.outcome.as_ref().expect("known result").is_ok() {
            LaptopNetworkProgress::Ready
        } else {
            LaptopNetworkProgress::Rejected
        }
    }
}
type RecordOwner = Arc<Mutex<Record>>;
#[derive(Clone)]
enum RetainedRecord {
    Created(RecordOwner),
    Source(RecordOwner),
    Existing(existing_viewer::ExistingRecordOwner),
}
impl RetainedRecord {
    fn is_source(&self, record: &RecordOwner) -> bool {
        matches!(self,Self::Source(current) if Arc::ptr_eq(current,record))
    }
    fn is_created(&self, record: &RecordOwner) -> bool {
        matches!(self,Self::Created(current) if Arc::ptr_eq(current,record))
    }
    fn is_existing(&self, record: &existing_viewer::ExistingRecordOwner) -> bool {
        matches!(self,Self::Existing(current) if Arc::ptr_eq(current,record))
    }
}
/// Same actual resource record; no DATA constructor or authority-bearing status.
#[must_use = "retain actual laptop resource custody until checked reclamation"]
#[derive(Clone)]
pub struct LaptopWorkflow {
    origin: Arc<InstalledWorkerEngine>,
    record: RecordOwner,
}
impl LaptopWorkflow {
    /// Retained original failure data; this does not change its native outcome
    /// or clear a resource/admission fence.
    pub fn failure(&self) -> Result<Option<Arc<LaptopError>>> {
        let record = self
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        Ok(record
            .outcome
            .as_ref()
            .and_then(|result| result.as_ref().err())
            .cloned())
    }
    pub fn same_workflow(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.origin, &other.origin) && Arc::ptr_eq(&self.record, &other.record)
    }
}
#[must_use = "retain every returned actual resource after refused handoff"]
pub struct LaptopRetainFailure {
    inputs: Inputs,
    error: LaptopError,
}
impl LaptopRetainFailure {
    pub fn cause(&self) -> &LaptopError {
        &self.error
    }
    pub fn into_parts(
        self: Box<Self>,
    ) -> (ObservedCreatePlan, WorkerRequest, OfficePhone, LaptopError) {
        let r = self.inputs;
        (r.plan, r.request, r.office, self.error)
    }
}
#[must_use = "retain the actual workflow when reclamation is refused"]
pub struct LaptopReclaimFailure {
    workflow: LaptopWorkflow,
    error: LaptopError,
}
impl LaptopReclaimFailure {
    pub fn cause(&self) -> &LaptopError {
        &self.error
    }
    pub fn into_parts(self) -> (LaptopWorkflow, LaptopError) {
        (self.workflow, self.error)
    }
}
/// No container has been created by this network phase. Returning resources
/// neither closes them nor acknowledges global writer/capacity release.
#[must_use = "restore all real owners to the installing lifecycle"]
pub struct LaptopNetworkReturned {
    nix: NixReturned,
    inputs: Inputs,
    outcome: std::result::Result<(), Arc<LaptopError>>,
}
impl LaptopNetworkReturned {
    pub fn into_parts(
        self,
    ) -> (
        NixReturned,
        ObservedCreatePlan,
        WorkerRequest,
        OfficePhone,
        std::result::Result<(), Arc<LaptopError>>,
    ) {
        let r = self.inputs;
        (self.nix, r.plan, r.request, r.office, self.outcome)
    }
}
pub(crate) struct Workflows {
    maximum: usize,
    records: Mutex<Vec<RetainedRecord>>,
}
impl Workflows {
    pub(crate) fn new(maximum: usize) -> Self {
        Self {
            maximum,
            records: Mutex::new(Vec::with_capacity(maximum)),
        }
    }
    fn retain(
        &self,
        runtime: &WorkerRuntime,
        nix: &NixWorkflow,
        inputs: Inputs,
        connection: Option<crate::worker_reports::terminal::RelayIdentity>,
    ) -> std::result::Result<LaptopWorkflow, Box<LaptopRetainFailure>> {
        let result = (|| {
            need(
                !runtime.cancellation().is_cancelled(),
                "WORKER_LAPTOP_STOPPED",
            )?;
            need(
                connection
                    .as_ref()
                    .is_none_or(|source| source.can_progress()),
                "VIEWER_CONNECTION_CLOSED",
            )?;
            runtime
                .nix_workflows()
                .assert_laptop_plan(runtime, nix, &inputs.plan)?;
            need(
                inputs.request.session() == inputs.plan.session()
                    && inputs.request.attach_only() != Some(true),
                "WORKER_LAPTOP_REQUEST_CHANGED",
            )?;
            inputs
                .office
                .assert_runtime_session(runtime, inputs.plan.session())
                .map_err(LaptopError::Office)?;
            let records = self
                .records
                .try_lock()
                .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
            need(records.len() < self.maximum, "WORKER_LAPTOP_CAPACITY")?;
            Ok(records)
        })();
        let mut records = match result {
            Ok(records) => records,
            Err(error) => return Err(Box::new(LaptopRetainFailure { inputs, error })),
        };
        let nix = match runtime.nix_workflows().reclaim_for_laptop(runtime, nix) {
            Ok(nix) => nix,
            Err(error) => {
                return Err(Box::new(LaptopRetainFailure {
                    inputs,
                    error: LaptopError::Nix(error),
                }));
            }
        };
        let resources = Resources {
            nix: guard::NixOwnership::Held(Box::new(nix)),
            plan: inputs.plan,
            request: inputs.request,
            office: inputs.office,
            connection,
        };
        let record = Arc::new(Mutex::new(Record {
            source_attachment: None,
            finalization: Default::default(),
            cold: Default::default(),
            resources: Some(resources),
            phase: Phase::Held,
            outcome: None,
            pending: None,
            unknown: false,
            settlement: None,
            creation: None,
            cleanup: None,
            viewer: None,
        }));
        records.push(RetainedRecord::Created(record.clone()));
        Ok(LaptopWorkflow {
            origin: runtime.installed_engine().clone(),
            record,
        })
    }
    fn bound(&self, runtime: &WorkerRuntime, workflow: &LaptopWorkflow) -> Result<()> {
        need(
            Arc::ptr_eq(runtime.installed_engine(), &workflow.origin),
            "WORKER_LAPTOP_RUNTIME_CHANGED",
        )?;
        let records = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            records.iter().any(|r| r.is_created(&workflow.record)),
            "WORKER_LAPTOP_REPLAYED",
        )
    }
    fn run_network(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        deadline: call_budget::CallBudget,
    ) -> Result<LaptopNetworkProgress> {
        self.bound(runtime, workflow)?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(record.phase == Phase::Held, "WORKER_LAPTOP_REPLAYED")?;
        record.phase = Phase::Running;
        record.outcome = Some(network::run(runtime, &mut record, deadline).map_err(Arc::new));
        if record.pending.is_none() && !record.unknown {
            record.phase = Phase::Known;
        } else {
            record.phase = Phase::Retained;
        }
        Ok(record.progress())
    }
    fn reclaim(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
    ) -> Result<LaptopNetworkReturned> {
        self.bound(runtime, workflow)?;
        let mut records = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record.pending.is_none()
                && !record.unknown
                && record.resources().held_nix().is_ok()
                && !record
                    .creation
                    .as_ref()
                    .is_some_and(create::Creation::owns_created),
            "WORKER_LAPTOP_RETAINED",
        )?;
        let resources = record.resources.take().expect("unreclaimed owners");
        let outcome = record.outcome.take().expect("known native result");
        record.phase = Phase::Consumed;
        records.retain(|r| !r.is_created(&workflow.record));
        let Resources {
            nix,
            plan,
            request,
            office,
            connection: _,
        } = resources;
        let guard::NixOwnership::Held(nix) = nix else {
            unreachable!("actual Held guard checked under this same record mutex")
        };
        Ok(LaptopNetworkReturned {
            nix: *nix,
            inputs: Inputs {
                plan,
                request,
                office,
            },
            outcome,
        })
    }
    pub(crate) fn settle(&self, runtime: &WorkerRuntime, deadline: Instant) -> Result<()> {
        let records = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?
            .clone();
        let mut result = Ok(());
        for record in records {
            let settled = match record {
                RetainedRecord::Created(record) | RetainedRecord::Source(record) => {
                    self.settle_record(runtime, &record, deadline)
                }
                RetainedRecord::Existing(record) => {
                    existing_viewer::settle_retained(runtime, &record, deadline)
                }
            };
            result = finalized(result, settled);
        }
        result
    }
    fn settle_record(
        &self,
        runtime: &WorkerRuntime,
        record: &RecordOwner,
        deadline: Instant,
    ) -> Result<()> {
        let mut record = record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase != Phase::FinalizingStarted,
            "WORKER_STARTED_FINAL_STORAGE_RETAINED",
        )?;
        if record.phase == Phase::Held && runtime.cancellation().is_cancelled() {
            record.outcome = Some(Err(Arc::new(LaptopError::Refused("WORKER_LAPTOP_STOPPED"))));
            record.phase = Phase::Known;
        }
        let viewer = record.viewer.clone();
        let memory_result = if runtime.cancellation().is_cancelled() || record.cleanup.is_some() {
            let memory = memory::close_abandoned(&mut record);
            let perf = perf::close_abandoned(&mut record);
            finalized(memory, perf)
        } else {
            Ok(())
        };
        let viewer_result = finalized(
            memory_result,
            viewer.map_or(Ok(()), |job| {
                runtime
                    .installed_engine()
                    .engine
                    .client
                    .settle_viewer(&job, deadline)
                    .map_err(|error| LaptopError::Engine(error.into()))
            }),
        );
        if let Some(call) = &record.pending {
            let deadline = runtime
                .stop_deadline()
                .map_or(deadline, |stop| deadline.min(stop));
            match runtime
                .installed_engine()
                .engine
                .client
                .settle_call(call, deadline)
            {
                Ok(()) => {
                    record.pending = None;
                    record.settlement = None;
                }
                Err(error) => {
                    record.settlement = Some(error.clone().into());
                    return finalized(viewer_result, Err(LaptopError::Engine(error.into())));
                }
            }
        }
        if !record.unknown && record.phase == Phase::Retained && record.outcome.is_some() {
            record.phase = Phase::Known;
        }
        finalized(
            viewer_result,
            need(
                !record.unknown
                    && record.phase != Phase::Running
                    && !record
                        .creation
                        .as_ref()
                        .is_some_and(create::Creation::owns_created),
                "WORKER_LAPTOP_RETAINED",
            ),
        )
    }
}
// Last-owner Drop cannot acknowledge unknown daemon/native outcomes. Retain
// actual resources for this process lifetime rather than unlocking on handle loss.
impl Drop for Workflows {
    fn drop(&mut self) {
        static ABANDONED: OnceLock<Mutex<Vec<RetainedRecord>>> = OnceLock::new();
        let records = self
            .records
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !records.is_empty() {
            ABANDONED
                .get_or_init(Mutex::default)
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .append(records);
        }
    }
}
impl WorkerRuntime {
    pub fn retain_laptop_network(
        &self,
        nix: &NixWorkflow,
        plan: ObservedCreatePlan,
        request: WorkerRequest,
        office: OfficePhone,
    ) -> std::result::Result<LaptopWorkflow, Box<LaptopRetainFailure>> {
        self.laptop_workflows().retain(
            self,
            nix,
            Inputs {
                plan,
                request,
                office,
            },
            None,
        )
    }
    pub fn run_laptop_network(
        &self,
        workflow: &LaptopWorkflow,
        deadline: Instant,
    ) -> Result<LaptopNetworkProgress> {
        self.laptop_workflows().run_network(
            self,
            workflow,
            call_budget::CallBudget::bounded(deadline),
        )
    }
    pub fn reclaim_laptop_network(
        &self,
        workflow: LaptopWorkflow,
    ) -> std::result::Result<LaptopNetworkReturned, LaptopReclaimFailure> {
        self.laptop_workflows()
            .reclaim(self, &workflow)
            .map_err(|error| LaptopReclaimFailure { workflow, error })
    }
}
