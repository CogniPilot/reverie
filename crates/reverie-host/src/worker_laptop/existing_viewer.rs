//! Genuine existing-storage viewer ownership, separate from created/Nix phases.
//! App supplies its actual classified reuse scope; these resources are not an
//! authorization, live-pane proof, admission release or source-stop permit.
use super::*;
mod finalization;
mod relay;
mod stop;
use crate::{
    worker_launch::ExistingLaptopInspection,
    worker_storage::{LaunchReceiptObservation, LaunchStorage},
};
pub use finalization::ExistingStorageObservation;
pub use relay::{
    ExistingRelayRetainFailure, ExistingRelayReturned, ExistingViewerReceiptObservation,
};
use std::sync::MutexGuard;

struct Inputs {
    storage: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    inspected: ExistingLaptopInspection,
    receipt: Option<LaunchReceiptObservation>,
    connection: Option<crate::worker_reports::terminal::RelayIdentity>,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Stage {
    Held,
    Starting,
    Viewing,
    Retained,
    Closing,
    Closed,
    Consumed,
}
pub(super) struct ExistingRecord {
    inputs: Option<Inputs>,
    stage: Stage,
    job: Option<Arc<ViewerJob>>,
    failure: Option<Arc<LaptopError>>,
    stop: stop::ExistingStop,
    finalization: finalization::StorageCheck,
}
pub(super) type ExistingRecordOwner = Arc<Mutex<ExistingRecord>>;
#[derive(Clone)]
pub(super) struct ExistingReference {
    origin: Arc<InstalledWorkerEngine>,
    pub(super) record: ExistingRecordOwner,
}
#[must_use = "retain the original storage owner and actual viewer through checked handoff"]
pub struct ExistingViewer {
    pub(super) reference: ExistingReference,
}
impl ExistingViewer {
    pub fn same_owner(&self, other: &Self) -> bool {
        self.reference.same_owner(&other.reference)
    }
    pub fn failure(&self) -> Result<Option<Arc<LaptopError>>> {
        Ok(self
            .reference
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?
            .failure
            .clone())
    }
}
impl ExistingReference {
    pub(super) fn same_owner(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.origin, &other.origin) && Arc::ptr_eq(&self.record, &other.record)
    }
}
#[must_use = "restore ALL original owners on a pre-effect refusal"]
pub struct ExistingViewerRetainFailure {
    inputs: Inputs,
    error: LaptopError,
}
impl ExistingViewerRetainFailure {
    pub fn cause(&self) -> &LaptopError {
        &self.error
    }
    pub fn into_parts(
        self: Box<Self>,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        WorkerRequest,
        ExistingLaptopInspection,
        LaptopError,
    ) {
        let Inputs {
            storage,
            plan,
            request,
            inspected,
            receipt: _,
            connection: _,
        } = self.inputs;
        (storage, plan, request, inspected, self.error)
    }
}
#[must_use = "uncertain construction keeps the actual box and job in the same inventory"]
pub enum ExistingViewerStart {
    Started(ViewerSession),
    Retained,
}

/// Holds both actual inventory/record guards. Until into_parts consumes this
/// guard, the original Box stays IN its counted record. Default Drop cannot
/// release the storage lease, erase a slot or manufacture a completed handoff.
#[must_use = "consume only inside the actual App registry restoration transaction"]
pub struct ExistingViewerReturned<'a> {
    inventory: MutexGuard<'a, Vec<RetainedRecord>>,
    record: MutexGuard<'a, ExistingRecord>,
    identity: &'a ExistingRecordOwner,
}
impl ExistingViewerReturned<'_> {
    pub fn into_parts(
        mut self,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        WorkerRequest,
        ExistingLaptopInspection,
        Option<Arc<LaptopError>>,
    ) {
        let Inputs {
            storage,
            plan,
            request,
            inspected,
            receipt: _,
            connection: _,
        } = self
            .record
            .inputs
            .take()
            .expect("checked original resource owner");
        let failure = self.record.failure.clone();
        self.record.stage = Stage::Consumed;
        self.inventory
            .retain(|entry| !entry.is_existing(self.identity));
        (storage, plan, request, inspected, failure)
    }
}
impl ExistingRecord {
    pub(super) fn assert_session(&self, job: &Arc<ViewerJob>, forward: bool) -> Result<()> {
        need(
            self.job
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, job)),
            "WORKER_VIEWER_ORIGIN",
        )?;
        if forward {
            need(self.stage == Stage::Viewing, "WORKER_VIEWER_PHASE")?;
        }
        Ok(())
    }
    fn close(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        need(
            self.stage != Stage::Consumed,
            "WORKER_EXISTING_VIEWER_CONSUMED",
        )?;
        if self.stage == Stage::Closed {
            return self.finalization.settle(runtime, end);
        }
        self.stage = Stage::Closing;
        let stopped_call = finalized(
            self.stop.settle(runtime, end),
            self.finalization.settle(runtime, end),
        );
        let viewer = self.job.as_ref().map_or(Ok(()), |job| {
            runtime
                .installed_engine()
                .engine
                .client
                .settle_viewer(job, end)
                .map_err(|error| LaptopError::Engine(error.into()))
        });
        let result = finalized(stopped_call, viewer);
        match result {
            Ok(()) => {
                self.stage = Stage::Closed;
                Ok(())
            }
            Err(error) => {
                self.stage = Stage::Retained;
                let error = Arc::new(error);
                if self.failure.is_none() {
                    self.failure = Some(error.clone());
                }
                Err(LaptopError::Recorded(error))
            }
        }
    }
}
pub(super) fn settle_retained(
    runtime: &WorkerRuntime,
    record: &ExistingRecordOwner,
    end: Instant,
) -> Result<()> {
    let mut record = record
        .try_lock()
        .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?;
    if record.stage == Stage::Consumed {
        return Ok(());
    }
    let closed = record.close(runtime, end);
    finalized(
        closed,
        need(
            record.stage == Stage::Consumed,
            "WORKER_EXISTING_VIEWER_STORAGE_HELD",
        ),
    )
}
impl Workflows {
    fn retain_existing(
        &self,
        runtime: &WorkerRuntime,
        inputs: Inputs,
    ) -> std::result::Result<ExistingViewer, Box<ExistingViewerRetainFailure>> {
        let result = (|| {
            need(
                !runtime.cancellation().is_cancelled(),
                "WORKER_LAPTOP_STOPPED",
            )?;
            inputs
                .plan
                .assert_storage_owner(runtime, &inputs.storage)
                .map_err(LaptopError::Plan)?;
            inputs
                .inspected
                .assert_plan(runtime, &inputs.plan)
                .map_err(LaptopError::ExistingObservation)?;
            if let Some(receipt) = &inputs.receipt {
                receipt
                    .assert_storage_owner(runtime, &inputs.storage)
                    .map_err(LaptopError::StorageOwner)?;
            }
            need(
                inputs.request.session() == inputs.plan.session(),
                "WORKER_LAPTOP_REQUEST_CHANGED",
            )?;
            let inventory = self
                .records
                .try_lock()
                .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
            need(inventory.len() < self.maximum, "WORKER_LAPTOP_CAPACITY")?;
            Ok(inventory)
        })();
        let mut inventory = match result {
            Ok(inventory) => inventory,
            Err(error) => return Err(Box::new(ExistingViewerRetainFailure { inputs, error })),
        };
        let record = Arc::new(Mutex::new(ExistingRecord {
            inputs: Some(inputs),
            stage: Stage::Held,
            job: None,
            failure: None,
            stop: stop::ExistingStop::default(),
            finalization: finalization::StorageCheck::default(),
        }));
        inventory.push(RetainedRecord::Existing(record.clone()));
        Ok(ExistingViewer {
            reference: ExistingReference {
                origin: runtime.installed_engine().clone(),
                record,
            },
        })
    }
    pub(super) fn bound_existing(
        &self,
        runtime: &WorkerRuntime,
        existing: &ExistingReference,
    ) -> Result<()> {
        need(
            Arc::ptr_eq(runtime.installed_engine(), &existing.origin),
            "WORKER_LAPTOP_RUNTIME_CHANGED",
        )?;
        let inventory = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            inventory
                .iter()
                .any(|entry| entry.is_existing(&existing.record)),
            "WORKER_EXISTING_VIEWER_REPLAYED",
        )
    }
    fn start_existing(
        &self,
        runtime: &WorkerRuntime,
        existing: &ExistingViewer,
        end: Instant,
        connection: Option<&crate::worker_reports::WorkerLaunchConnection>,
    ) -> Result<ExistingViewerStart> {
        self.bound_existing(runtime, &existing.reference)?;
        let mut record = existing
            .reference
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?;
        need(
            record.stage == Stage::Held && record.job.is_none(),
            "WORKER_EXISTING_VIEWER_PHASE",
        )?;
        record.stop.require_startable()?;
        need(
            !runtime.cancellation().is_cancelled()
                && Instant::now() < viewer::clipped(runtime, end),
            "WORKER_VIEWER_STOPPED",
        )?;
        let inputs = record.inputs.as_ref().expect("held real box");
        inputs
            .plan
            .assert_storage_owner(runtime, &inputs.storage)
            .map_err(LaptopError::Plan)?;
        inputs
            .inspected
            .assert_plan(runtime, &inputs.plan)
            .map_err(LaptopError::ExistingObservation)?;
        let supplied = connection
            .map(|connection| {
                connection
                    .viewer_constructor_identity(runtime, inputs.plan.session())
                    .map_err(LaptopError::Refused)
            })
            .transpose()?;
        need(
            match (&inputs.connection, &supplied) {
                (None, None) => true,
                (Some(original), Some(supplied)) => original.same(supplied),
                _ => false,
            },
            "VIEWER_CONNECTION_CHANGED",
        )?;
        let source = inputs.connection.clone();
        let mut marker = [0; 16];
        getrandom::getrandom(&mut marker)
            .map_err(|error| LaptopError::Io(std::io::Error::other(error.to_string())))?;
        let job = ViewerJob::new(
            runtime,
            inputs.plan.arguments().worker_name().clone(),
            inputs.request.terminal(),
            marker,
            source,
        );
        record.job = Some(job.clone());
        record.stage = Stage::Starting;
        match viewer::launch_constructor(runtime, &job, end) {
            Ok(()) => {
                record.stage = Stage::Viewing;
                Ok(ExistingViewerStart::Started(ViewerSession::existing(
                    existing.reference.clone(),
                    job,
                )))
            }
            Err(error) => {
                record.stage = Stage::Retained;
                record.failure = Some(error);
                Ok(ExistingViewerStart::Retained)
            }
        }
    }
    fn close_existing(
        &self,
        runtime: &WorkerRuntime,
        existing: &ExistingViewer,
        end: Instant,
    ) -> Result<()> {
        self.bound_existing(runtime, &existing.reference)?;
        existing
            .reference
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?
            .close(runtime, end)
    }
    fn reclaim_existing<'a>(
        &'a self,
        runtime: &WorkerRuntime,
        existing: &'a ExistingViewer,
        relay: bool,
        finalization: Option<&ExistingStorageObservation>,
    ) -> Result<ExistingViewerReturned<'a>> {
        need(
            Arc::ptr_eq(runtime.installed_engine(), &existing.reference.origin),
            "WORKER_LAPTOP_RUNTIME_CHANGED",
        )?;
        let inventory = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            inventory
                .iter()
                .any(|entry| entry.is_existing(&existing.reference.record)),
            "WORKER_EXISTING_VIEWER_REPLAYED",
        )?;
        let record = existing
            .reference
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?;
        need(
            matches!(record.stage, Stage::Held | Stage::Closed) && record.inputs.is_some(),
            "WORKER_EXISTING_VIEWER_RETAINED",
        )?;
        record.stop.require_reclaimable()?;
        record
            .finalization
            .require_reclaimable(existing, finalization)?;
        need(
            record
                .inputs
                .as_ref()
                .is_some_and(|inputs| inputs.receipt.is_some() == relay),
            "WORKER_EXISTING_VIEWER_PURPOSE",
        )?;
        Ok(ExistingViewerReturned {
            inventory,
            record,
            identity: &existing.reference.record,
        })
    }
}
impl WorkerRuntime {
    /// Pure same-origin resource transfer only; actual App classified reuse,
    /// current intent, held lifecycle and admission release remain mandatory.
    pub fn retain_existing_viewer(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
        request: WorkerRequest,
        inspected: ExistingLaptopInspection,
    ) -> std::result::Result<ExistingViewer, Box<ExistingViewerRetainFailure>> {
        self.laptop_workflows().retain_existing(
            self,
            Inputs {
                storage,
                plan,
                request,
                inspected,
                receipt: None,
                connection: None,
            },
        )
    }
    pub fn start_existing_viewer(
        &self,
        existing: &ExistingViewer,
        end: Instant,
    ) -> Result<ExistingViewerStart> {
        self.laptop_workflows()
            .start_existing(self, existing, end, None)
    }
    pub fn start_existing_viewer_for_connection(
        &self,
        existing: &ExistingViewer,
        connection: &crate::worker_reports::WorkerLaunchConnection,
        end: Instant,
    ) -> Result<ExistingViewerStart> {
        self.laptop_workflows()
            .start_existing(self, existing, end, Some(connection))
    }
    pub fn close_existing_viewer(&self, existing: &ExistingViewer, end: Instant) -> Result<()> {
        self.laptop_workflows().close_existing(self, existing, end)
    }
    pub fn reclaim_existing_viewer<'a>(
        &'a self,
        existing: &'a ExistingViewer,
    ) -> Result<ExistingViewerReturned<'a>> {
        self.laptop_workflows()
            .reclaim_existing(self, existing, false, None)
    }
}
