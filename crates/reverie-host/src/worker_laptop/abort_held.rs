//! Pure return of a genuinely undispatched network record. This never mints a
//! stopped-container result or converts a native outcome into known absence.
use super::*;
use crate::worker_reports::WorkerLaunchConnection;
use std::sync::MutexGuard;

/// The originals remain in the same counted record until this guard is
/// consumed inside the caller's already checked registry restoration.
#[must_use = "dropping this guard retains all originals in their counted record"]
pub struct HeldLaptopNetworkReturn<'a> {
    inventory: MutexGuard<'a, Vec<RetainedRecord>>,
    record: MutexGuard<'a, Record>,
    identity: &'a RecordOwner,
}
impl HeldLaptopNetworkReturn<'_> {
    pub fn into_parts(mut self) -> (NixReturned, ObservedCreatePlan, WorkerRequest, OfficePhone) {
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
            .expect("checked undispatched originals");
        let guard::NixOwnership::Held(nix) = nix else {
            unreachable!("same actual held Nix owner checked under record lock");
        };
        self.record.phase = Phase::Consumed;
        self.inventory
            .retain(|entry| !entry.is_created(self.identity));
        (*nix, plan, request, office)
    }
}
impl WorkerRuntime {
    /// Actual worker cleanup purpose. The same accepted J identity is checked
    /// even if its socket or forward progress has already been closed.
    pub fn abort_held_laptop_network<'a>(
        &'a self,
        workflow: &'a LaptopWorkflow,
        connection: &WorkerLaunchConnection,
    ) -> Result<HeldLaptopNetworkReturn<'a>> {
        let workflows = self.laptop_workflows();
        workflows.assert_worker_cleanup_connection(self, workflow, connection)?;
        let inventory = workflows
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            inventory
                .iter()
                .any(|entry| entry.is_created(&workflow.record)),
            "WORKER_LAPTOP_REPLAYED",
        )?;
        let record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Held
                && record.outcome.is_none()
                && record.creation.is_none()
                && record.pending.is_none()
                && !record.unknown
                && record.viewer.is_none()
                && record.cleanup.is_none()
                && record.settlement.is_none()
                && record.resources().held_nix().is_ok(),
            "WORKER_LAPTOP_NETWORK_ALREADY_ATTEMPTED",
        )?;
        record
            .resources()
            .plan
            .assert_storage_owner(self, record.resources().storage())
            .map_err(LaptopError::Plan)?;
        Ok(HeldLaptopNetworkReturn {
            inventory,
            record,
            identity: &workflow.record,
        })
    }
}
