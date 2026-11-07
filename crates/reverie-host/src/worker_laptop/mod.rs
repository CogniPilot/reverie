//! Fixed laptop effects retain actual Nix/storage/Office owners before the
//! first native client. InstallingBroker still owns admission and authorization.
mod cleanup;
mod cold;
mod create;
mod error;
mod memory;
mod network;
mod publication;
mod start;
#[cfg(test)]
mod tests;
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
pub use error::{CreateTelemetryFailure, LaptopError, TelemetryCause};
use error::{Result, finalized, need};
pub use memory::{ConfiguredMemory, MemoryConfiguration};
use reverie_contracts::worker_launch::WorkerRequest;
pub use start::{ContainerStart, StartedContainer};
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
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
    Stopped,
    CleanupRetained,
    Consumed,
}
struct Resources {
    nix: NixReturned,
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    office: OfficePhone,
}
struct Inputs {
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    office: OfficePhone,
}
struct Record {
    resources: Option<Resources>,
    phase: Phase,
    outcome: Option<std::result::Result<(), Arc<LaptopError>>>,
    pending: Option<crate::captured_client::CapturedCall>,
    unknown: bool,
    settlement: Option<crate::engine_metadata::EngineError>,
    creation: Option<create::Creation>,
    cleanup: Option<cleanup::Cleanup>,
}
impl Record {
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
    resources: Resources,
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
        let r = self.resources;
        (r.nix, r.plan, r.request, r.office, self.outcome)
    }
}
pub(crate) struct Workflows {
    maximum: usize,
    records: Mutex<Vec<RecordOwner>>,
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
    ) -> std::result::Result<LaptopWorkflow, Box<LaptopRetainFailure>> {
        let result = (|| {
            need(
                !runtime.cancellation().is_cancelled(),
                "WORKER_LAPTOP_STOPPED",
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
            nix,
            plan: inputs.plan,
            request: inputs.request,
            office: inputs.office,
        };
        let record = Arc::new(Mutex::new(Record {
            resources: Some(resources),
            phase: Phase::Held,
            outcome: None,
            pending: None,
            unknown: false,
            settlement: None,
            creation: None,
            cleanup: None,
        }));
        records.push(record.clone());
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
            records.iter().any(|r| Arc::ptr_eq(r, &workflow.record)),
            "WORKER_LAPTOP_REPLAYED",
        )
    }
    fn run_network(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        deadline: Instant,
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
                && !record
                    .creation
                    .as_ref()
                    .is_some_and(create::Creation::owns_created),
            "WORKER_LAPTOP_RETAINED",
        )?;
        let resources = record.resources.take().expect("unreclaimed owners");
        let outcome = record.outcome.take().expect("known native result");
        record.phase = Phase::Consumed;
        records.retain(|r| !Arc::ptr_eq(r, &workflow.record));
        Ok(LaptopNetworkReturned { resources, outcome })
    }
    pub(crate) fn settle(&self, runtime: &WorkerRuntime, deadline: Instant) -> Result<()> {
        let records = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?
            .clone();
        let mut result = Ok(());
        for record in records {
            result = finalized(result, self.settle_record(runtime, &record, deadline));
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
        if record.phase == Phase::Held && runtime.cancellation().is_cancelled() {
            record.outcome = Some(Err(Arc::new(LaptopError::Refused("WORKER_LAPTOP_STOPPED"))));
            record.phase = Phase::Known;
        }
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
                    return Err(LaptopError::Engine(error.into()));
                }
            }
        }
        if !record.unknown && record.phase == Phase::Retained && record.outcome.is_some() {
            record.phase = Phase::Known;
        }
        need(
            !record.unknown
                && record.phase != Phase::Running
                && !record
                    .creation
                    .as_ref()
                    .is_some_and(create::Creation::owns_created),
            "WORKER_LAPTOP_RETAINED",
        )
    }
}
// Last-owner Drop cannot acknowledge unknown daemon/native outcomes. Retain
// actual resources for this process lifetime rather than unlocking on handle loss.
impl Drop for Workflows {
    fn drop(&mut self) {
        static ABANDONED: OnceLock<Mutex<Vec<RecordOwner>>> = OnceLock::new();
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
        )
    }
    pub fn run_laptop_network(
        &self,
        workflow: &LaptopWorkflow,
        deadline: Instant,
    ) -> Result<LaptopNetworkProgress> {
        self.laptop_workflows()
            .run_network(self, workflow, deadline)
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
