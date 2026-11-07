//! Later-J replacement moves the same actual storage straight into its real
//! stop owner. A refused pure factory restores the entire original remainder.
use super::*;
use crate::{
    worker_launch::{ExistingLaptopInspection, ExistingProcessIncarnation},
    worker_reports::WorkerLaunchConnection,
    worker_source_stop::{OrdinaryLaptopStop, OrdinaryReplacementStop},
};
use std::sync::MutexGuard;

#[must_use = "retain the actual stop and original Office through cleanup"]
pub struct StartedOrdinaryStopTransferred {
    stop: OrdinaryLaptopStop,
    office: OfficePhone,
    request: WorkerRequest,
}
impl StartedOrdinaryStopTransferred {
    pub fn into_parts(self) -> (OrdinaryLaptopStop, OfficePhone, WorkerRequest) {
        (self.stop, self.office, self.request)
    }
}
#[must_use = "retain the actual replacement stop and original Office"]
pub struct StartedReplacementStopTransferred {
    stop: OrdinaryReplacementStop,
    office: OfficePhone,
    request: WorkerRequest,
}
impl StartedReplacementStopTransferred {
    pub fn into_parts(self) -> (OrdinaryReplacementStop, OfficePhone, WorkerRequest) {
        (self.stop, self.office, self.request)
    }
}
struct Transfer<'a> {
    record: MutexGuard<'a, Record>,
    inventory: MutexGuard<'a, Vec<RetainedRecord>>,
    identity: &'a RecordOwner,
}
pub(super) struct Remainder {
    metadata: guard::ClosedGuardMetadata,
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    office: OfficePhone,
    connection: Option<crate::worker_reports::terminal::RelayIdentity>,
}
impl Remainder {
    pub(super) fn into_phone_request(self) -> (OfficePhone, WorkerRequest) {
        (self.office, self.request)
    }
}
impl Transfer<'_> {
    fn take(&mut self) -> (Box<crate::worker_storage::LaunchStorage>, Remainder) {
        split(self.record.resources.take().expect("same locked resource"))
    }
    fn restore(&mut self, storage: Box<crate::worker_storage::LaunchStorage>, rest: Remainder) {
        self.record.resources = Some(restore(*storage, rest));
    }
    fn consumed(mut self, rest: Remainder) -> (OfficePhone, WorkerRequest) {
        self.record.phase = Phase::Consumed;
        self.inventory
            .retain(|entry| !entry.is_created(self.identity));
        (rest.office, rest.request)
    }
}
pub(super) fn split(
    resources: Resources,
) -> (Box<crate::worker_storage::LaunchStorage>, Remainder) {
    let Resources {
        nix,
        plan,
        request,
        office,
        connection,
    } = resources;
    let (storage, metadata) = nix.into_closed_parts();
    (
        Box::new(storage),
        Remainder {
            metadata,
            plan,
            request,
            office,
            connection,
        },
    )
}
pub(super) fn restore(storage: crate::worker_storage::LaunchStorage, rest: Remainder) -> Resources {
    Resources {
        nix: guard::NixOwnership::restore_closed_storage(storage, rest.metadata),
        plan: rest.plan,
        request: rest.request,
        office: rest.office,
        connection: rest.connection,
    }
}
impl WorkerRuntime {
    pub fn transfer_started_laptop_ordinary_stop_for_worker(
        &self,
        created: &CreatedLaptop,
        plan: ObservedCreatePlan,
        inspected: ExistingLaptopInspection,
        connection: &WorkerLaunchConnection,
    ) -> Result<StartedOrdinaryStopTransferred> {
        let mut transfer = self
            .laptop_workflows()
            .started_transfer(self, created, &plan, connection)?;
        inspected
            .assert_plan(self, &plan)
            .map_err(LaptopError::ExistingObservation)?;
        require_identity(&transfer.record, inspected.data().canonical_id().as_ref())?;
        let (storage, rest) = transfer.take();
        match self.retain_ordinary_laptop_stop_for_worker(storage, plan, inspected) {
            Ok(stop) => {
                let (office, request) = transfer.consumed(rest);
                Ok(StartedOrdinaryStopTransferred {
                    stop,
                    office,
                    request,
                })
            }
            Err(failure) => {
                let (storage, _plan, _inspection, error) = (*failure).into_parts();
                transfer.restore(storage, rest);
                Err(LaptopError::OrdinaryStop(error))
            }
        }
    }
    pub fn transfer_started_laptop_replacement_stop_for_worker(
        &self,
        created: &CreatedLaptop,
        plan: ObservedCreatePlan,
        process: ExistingProcessIncarnation,
        connection: &WorkerLaunchConnection,
    ) -> Result<StartedReplacementStopTransferred> {
        let mut transfer = self
            .laptop_workflows()
            .started_transfer(self, created, &plan, connection)?;
        process
            .assert_plan(self, &plan)
            .map_err(LaptopError::ExistingObservation)?;
        process
            .assert_storage_owner(self, transfer.record.resources().storage())
            .map_err(LaptopError::ExistingObservation)?;
        require_identity(&transfer.record, process.data().canonical_id().as_ref())?;
        let (storage, rest) = transfer.take();
        match self.retain_ordinary_replacement_stop(storage, plan, process, None) {
            Ok(stop) => {
                let (office, request) = transfer.consumed(rest);
                Ok(StartedReplacementStopTransferred {
                    stop,
                    office,
                    request,
                })
            }
            Err(failure) => {
                let (storage, _plan, _process, error) = (*failure).into_parts();
                transfer.restore(storage, rest);
                Err(LaptopError::OrdinaryStop(error))
            }
        }
    }
}
impl Workflows {
    fn started_transfer<'a>(
        &'a self,
        runtime: &WorkerRuntime,
        created: &'a CreatedLaptop,
        plan: &ObservedCreatePlan,
        connection: &WorkerLaunchConnection,
    ) -> Result<Transfer<'a>> {
        let record = self.started_storage_record(runtime, created)?;
        let resources = record.resources();
        let next = connection
            .viewer_constructor_identity(runtime, resources.plan.session())
            .map_err(LaptopError::Refused)?;
        resources
            .connection
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_STARTED_CONNECTION_REQUIRED"))?
            .require_released_predecessor(&next)
            .map_err(LaptopError::Refused)?;
        require_closed(runtime, &record, plan)?;
        let inventory = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            inventory
                .iter()
                .any(|entry| entry.is_created(&created.workflow.record)),
            "WORKER_LAPTOP_REPLAYED",
        )?;
        Ok(Transfer {
            record,
            inventory,
            identity: &created.workflow.record,
        })
    }
}
pub(super) fn require_closed(
    runtime: &WorkerRuntime,
    record: &Record,
    plan: &ObservedCreatePlan,
) -> Result<()> {
    let resources = record.resources();
    resources.nix.require_guard_close()?;
    plan.assert_storage_owner(runtime, resources.storage())
        .map_err(LaptopError::Plan)?;
    resources
        .storage()
        .check_resource_current()
        .map_err(LaptopError::StorageOwner)?;
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
pub(super) fn require_identity(
    record: &Record,
    id: Option<&reverie_core::ids::ContainerId>,
) -> Result<()> {
    let actual = record
        .creation
        .as_ref()
        .and_then(|creation| creation.container.as_ref())
        .ok_or(LaptopError::Refused(
            "WORKER_LAPTOP_CREATED_CID_RECONCILIATION_REQUIRED",
        ))?;
    need(id == Some(actual), "WORKER_STARTED_IDENTITY_CHANGED")
}
