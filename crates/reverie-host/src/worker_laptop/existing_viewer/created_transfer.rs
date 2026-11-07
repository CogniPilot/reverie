//! A later genuine J consumes the SAME Started resource into the SAME bounded
//! inventory slot. Old Created/pane aliases cannot forward after this move.
use super::*;
use crate::worker_reports::WorkerLaunchConnection;

#[must_use = "retain both the actual relay and its original Office owner"]
pub struct StartedRelayTransferred {
    existing: ExistingViewer,
    office: OfficePhone,
    original_request: WorkerRequest,
}
impl StartedRelayTransferred {
    pub fn into_parts(self) -> (ExistingViewer, OfficePhone, WorkerRequest) {
        (self.existing, self.office, self.original_request)
    }
}
impl WorkerRuntime {
    /// Only the later canonical J may take this purpose. The original J must
    /// already be physically closed and its actual logical Hold Released.
    /// Failed checks leave all actual resource owners in the Created record.
    pub fn transfer_started_laptop_relay(
        &self,
        created: &CreatedLaptop,
        plan: ObservedCreatePlan,
        inspected: ExistingLaptopInspection,
        receipt: LaunchReceiptObservation,
        connection: &WorkerLaunchConnection,
    ) -> Result<StartedRelayTransferred> {
        let workflows = self.laptop_workflows();
        let mut record = workflows.started_storage_record(self, created)?;
        let next = check_transfer(self, &record, &plan, &inspected, &receipt, connection)?;
        let mut inventory = workflows
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let slot = inventory
            .iter_mut()
            .find(|entry| entry.is_created(&created.workflow.record))
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_REPLAYED"))?;
        // Every fallible check precedes the move. Both inventories are one
        // slot, so no capacity permit is released or reacquired in between.
        let Resources {
            nix,
            plan: _,
            request,
            office,
            connection: _,
        } = record
            .resources
            .take()
            .expect("checked same actual storage");
        let inputs = Inputs {
            storage: Box::new(nix.into_closed_storage()),
            plan,
            request: connection.request().clone(),
            inspected,
            receipt: Some(receipt),
            connection: Some(next),
        };
        let next = Arc::new(Mutex::new(ExistingRecord {
            inputs: Some(inputs),
            stage: Stage::Held,
            job: None,
            failure: None,
            stop: Default::default(),
            finalization: Default::default(),
        }));
        record.phase = Phase::Consumed;
        *slot = RetainedRecord::Existing(next.clone());
        Ok(StartedRelayTransferred {
            existing: ExistingViewer {
                reference: ExistingReference {
                    origin: self.installed_engine().clone(),
                    record: next,
                },
            },
            office,
            original_request: request,
        })
    }
}
fn check_transfer(
    runtime: &WorkerRuntime,
    record: &Record,
    plan: &ObservedCreatePlan,
    inspected: &ExistingLaptopInspection,
    receipt: &LaunchReceiptObservation,
    connection: &WorkerLaunchConnection,
) -> Result<crate::worker_reports::terminal::RelayIdentity> {
    need(
        !runtime.cancellation().is_cancelled(),
        "WORKER_LAPTOP_STOPPED",
    )?;
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
    resources.nix.require_guard_close()?;
    storage_cleanup::require_viewer_closed(runtime, record)?;
    plan.assert_storage_owner(runtime, resources.storage())
        .map_err(LaptopError::Plan)?;
    need(
        plan.session() == resources.plan.session(),
        "WORKER_LAPTOP_REQUEST_CHANGED",
    )?;
    inspected
        .assert_plan(runtime, plan)
        .map_err(LaptopError::ExistingObservation)?;
    let actual = record
        .creation
        .as_ref()
        .and_then(|creation| creation.container.as_ref())
        .ok_or(LaptopError::Refused(
            "WORKER_LAPTOP_CREATED_CID_RECONCILIATION_REQUIRED",
        ))?;
    need(
        inspected.data().canonical_id().as_ref() == Some(actual),
        "WORKER_STARTED_IDENTITY_CHANGED",
    )?;
    receipt
        .assert_storage_owner(runtime, resources.storage())
        .map_err(LaptopError::StorageOwner)?;
    resources
        .storage()
        .check_resource_current()
        .map_err(LaptopError::StorageOwner)?;
    if let Some(publication) = record
        .creation
        .as_ref()
        .and_then(|creation| creation.publication.as_ref())
    {
        publication.require_native_closed()?;
    }
    Ok(next)
}
