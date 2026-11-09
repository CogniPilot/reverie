//! A fresh named-storage observation and checked return of the SAME created
//! record. Observation is DATA; only actual stopped/closed owners can return.
use super::*;
use crate::worker_storage::LaunchStorage;
use std::sync::MutexGuard;

#[derive(Default)]
pub(super) struct StorageCheck {
    attempted: bool,
    current: Option<Arc<()>>,
    failure: Option<Arc<LaptopError>>,
    live: Option<bool>,
}
pub struct CreatedStorageObservation {
    workflow: LaptopWorkflow,
    current: Arc<()>,
    live: bool,
}
impl CreatedStorageObservation {
    pub fn is_live(&self) -> bool {
        self.live
    }
    pub fn same_workflow(&self, workflow: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(workflow)
    }
}
impl StorageCheck {
    pub(super) fn untouched(&self) -> bool {
        !self.attempted
    }
    /// A later real owner may borrow this same resource after a successful
    /// LIVE readback. Its actual predecessor and local native closes are
    /// checked separately; a false/failed observation cannot reopen it.
    pub(super) fn available_for_started_owner(&self) -> bool {
        self.untouched()
            || (self.live == Some(true) && self.current.is_some() && self.failure.is_none())
    }
    pub(super) fn require_stopped(
        &self,
        workflow: &LaptopWorkflow,
        observation: &CreatedStorageObservation,
    ) -> Result<()> {
        need(
            self.attempted
                && self.failure.is_none()
                && !observation.live
                && observation.same_workflow(workflow)
                && self
                    .current
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &observation.current)),
            "WORKER_CREATED_FINAL_STORAGE_UNCONFIRMED",
        )
    }
}
/// Default Drop leaves every real owner IN its counted record. App must hold
/// its own registry transaction before consuming this return; this is no ACK.
#[must_use = "retain the actual counted resources until registry restoration"]
pub struct StoppedCreatedReturned<'a> {
    inventory: MutexGuard<'a, Vec<RetainedRecord>>,
    record: MutexGuard<'a, Record>,
    identity: &'a RecordOwner,
    origin: ReturnOrigin,
}
enum ReturnOrigin {
    Created,
    Source,
}
impl<'a> StoppedCreatedReturned<'a> {
    pub(super) fn source(
        inventory: MutexGuard<'a, Vec<RetainedRecord>>,
        record: MutexGuard<'a, Record>,
        identity: &'a RecordOwner,
    ) -> Self {
        Self {
            inventory,
            record,
            identity,
            origin: ReturnOrigin::Source,
        }
    }
}
impl StoppedCreatedReturned<'_> {
    pub fn into_parts(
        mut self,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        WorkerRequest,
        OfficePhone,
        Option<Arc<LaptopError>>,
    ) {
        let Resources {
            nix,
            plan,
            request,
            office,
            connection: _,
        } = self
            .record
            .resources
            .take()
            .expect("checked retained owners");
        let failure = self
            .record
            .outcome
            .as_ref()
            .and_then(|result| result.as_ref().err())
            .cloned();
        let storage = nix.into_closed_storage();
        self.record.phase = Phase::Consumed;
        self.record.source_attachment = None;
        self.inventory.retain(|entry| match self.origin {
            ReturnOrigin::Created => !entry.is_created(self.identity),
            ReturnOrigin::Source => !entry.is_source(self.identity),
        });
        (Box::new(storage), plan, request, office, failure)
    }
}
impl WorkerRuntime {
    /// Uses the actual creation's optional original CID. None is never an
    /// absence proof: a failed inspect requires the full successful census.
    pub fn observe_created_final_storage(
        &self,
        created: &CreatedLaptop,
    ) -> Result<CreatedStorageObservation> {
        self.laptop_workflows().bound(self, &created.workflow)?;
        let mut record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        observe_closed(self, &mut record, &created.workflow)
    }
    pub fn prepare_stopped_created_return<'a>(
        &'a self,
        stopped: &'a StoppedCreatedLaptop,
        observation: &CreatedStorageObservation,
    ) -> Result<StoppedCreatedReturned<'a>> {
        self.laptop_workflows().bound(self, &stopped.workflow)?;
        let inventory = self
            .laptop_workflows()
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let record = stopped
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        require_return(self, &record, &stopped.workflow, observation)?;
        Ok(StoppedCreatedReturned {
            inventory,
            record,
            identity: &stopped.workflow.record,
            origin: ReturnOrigin::Created,
        })
    }
}
pub(super) fn observe_closed(
    runtime: &WorkerRuntime,
    record: &mut Record,
    workflow: &LaptopWorkflow,
) -> Result<CreatedStorageObservation> {
    need(
        matches!(
            record.phase,
            Phase::Cleaning | Phase::Stopped | Phase::CleanupRetained
        ) && !record.finalization.attempted
            && record.pending.is_none(),
        "WORKER_CREATED_FINAL_STORAGE_PHASE",
    )?;
    storage_cleanup::require_viewer_closed(runtime, record)?;
    record.finalization.attempted = true;
    match observe(runtime, record) {
        Ok(live) => {
            let current = Arc::new(());
            record.finalization.current = Some(current.clone());
            record.finalization.live = Some(live);
            Ok(CreatedStorageObservation {
                workflow: workflow.clone(),
                current,
                live,
            })
        }
        Err(error) => {
            let error = Arc::new(error);
            record.finalization.failure = Some(error.clone());
            Err(LaptopError::Recorded(error))
        }
    }
}
fn observe(runtime: &WorkerRuntime, record: &mut Record) -> Result<bool> {
    let Record {
        resources,
        creation,
        pending,
        ..
    } = record;
    let resources = resources.as_ref().expect("retained actual resources");
    let creation = creation
        .as_ref()
        .ok_or(LaptopError::Refused("WORKER_LAPTOP_CREATED_OWNER_REQUIRED"))?;
    need(
        creation.owns_created(),
        "WORKER_LAPTOP_CREATED_OWNER_REQUIRED",
    )?;
    final_storage::observe(
        runtime,
        pending,
        resources.storage(),
        &resources.plan,
        creation.container.as_ref(),
    )
}
fn require_return(
    runtime: &WorkerRuntime,
    record: &Record,
    workflow: &LaptopWorkflow,
    observation: &CreatedStorageObservation,
) -> Result<()> {
    need(
        record.phase == Phase::Stopped
            && record.pending.is_none()
            && !record.unknown
            && record
                .cleanup
                .as_ref()
                .is_some_and(|cleanup| cleanup.confirmed()),
        "WORKER_CREATED_RETURN_UNCONFIRMED",
    )?;
    record.finalization.require_stopped(workflow, observation)?;
    require_native_closed(runtime, record)
}
pub(super) fn require_native_closed(runtime: &WorkerRuntime, record: &Record) -> Result<()> {
    let resources = record.resources();
    resources.nix.require_guard_close()?;
    resources
        .plan
        .assert_storage_owner(runtime, resources.storage())
        .map_err(LaptopError::Plan)?;
    resources
        .storage()
        .check_resource_current()
        .map_err(|error| LaptopError::Nix(crate::worker_nix::NixError::Owner(error)))?;
    resources
        .office
        .require_closed_for_resource(runtime, resources.plan.session())
        .map_err(LaptopError::Office)?;
    storage_cleanup::require_viewer_closed(runtime, record)?;
    if let Some(publication) = record
        .creation
        .as_ref()
        .and_then(|creation| creation.publication.as_ref())
    {
        publication.require_native_closed()?;
    }
    Ok(())
}

impl StorageCheck {
    pub(super) fn diagnostic_phase(&self) -> reverie_contracts::worker_storage_status::CheckPhase {
        use reverie_contracts::worker_storage_status::CheckPhase;
        if !self.attempted {
            CheckPhase::Unattempted
        } else if self.failure.is_some() {
            CheckPhase::Failed
        } else if self.current.is_some() {
            CheckPhase::Known
        } else {
            CheckPhase::Reading
        }
    }
}
