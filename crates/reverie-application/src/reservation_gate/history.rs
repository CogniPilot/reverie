use super::*;
use reverie_contracts::reservation_history::{self, HistoricalCompletion};
use reverie_core::{
    capacity::{CapacityCounter, pool_headroom_fits},
    decimal::UnsignedInteger,
    ids::ProfileEmployeeId,
    operations::{Operation, OperationDocument, OperationState},
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HeadroomFacts {
    pub budget_bytes: u64,
    pub committed_bytes: u64,
    pub retained_bytes: u64,
}
impl Inner {
    pub(super) fn document(self: &Arc<Self>) -> Result<OperationDocument> {
        let store = self.store()?;
        let document = store.snapshot(&self.scope).map_err(Into::into);
        finalized(document, store.close().map_err(Into::into))
    }
    pub(super) fn active_operations(&self, document: &OperationDocument) -> Result<Vec<Operation>> {
        self.consistent_pending(document)?;
        let mut active = Vec::new();
        for operation in document.operations().values() {
            if !self.historically_completed(operation)? {
                active.push(operation.clone());
            }
        }
        Ok(active)
    }
    fn consistent_pending(&self, document: &OperationDocument) -> Result<()> {
        // Path.iterdir consumes/checked-closes the native enumeration first.
        // The count includes every entry; no sorting can move a file failure.
        let names = reservation_control::settlement_names(&self.config)?;
        for (index, name) in names.iter().enumerate() {
            reservation_history::validate_pending_position(index)?;
            if let Some(id) = reservation_history::pending_operation_id(name)? {
                let data = reservation_control::read_settlement_pending(&self.config, &id)?;
                reservation_history::validate_pending(&id, &data, document)?;
            }
        }
        Ok(())
    }
    fn historically_completed(&self, operation: &Operation) -> Result<bool> {
        if operation.data().state != OperationState::Completed {
            return Ok(false);
        }
        let id = &operation.data().id;
        let receipt = reservation_control::read_completion_receipt(&self.config, id)?;
        let completed = HistoricalCompletion::capture(operation, &receipt)?;
        let verified = reservation_control::read_verification_receipt(&self.config, id)?;
        completed.assert_verified_and_plan(&verified)?;
        Ok(!reservation_control::settlement_pending_present(
            &self.config,
            id,
        )?)
    }
    pub(super) fn retained_delta(&self, document: &OperationDocument) -> Result<UnsignedInteger> {
        let active = self.active_operations(document)?;
        for operation in &active {
            let op = operation.data();
            let eid = ProfileEmployeeId::parse(op.request.employee_id.as_str())
                .expect("checked journal ID is a profile UUID");
            let current = self.observe(&op.scope, &op.request.pool_id, &eid)?;
            need(
                current.fields().source_binding == op.observation.data().source_binding_digest
                    && current.fields().current_memory
                        == op.observation.data().current_memory_bytes,
                "RESERVATION_RECONCILIATION_REQUIRED",
            )?;
        }
        Ok(active.iter().fold(UnsignedInteger::from_u64(0), |sum, op| {
            sum.plus(&UnsignedInteger::from_u64(op.data().delta_bytes))
        }))
    }
    pub(super) fn check_headroom(self: &Arc<Self>) -> Result<HeadroomFacts> {
        self.require_host_job_idle()?;
        let rows = self.guard(None)?;
        let native = self.native_context()?;
        let capacity = native.capacity(&rows)?;
        let retained = self.retained_delta(&self.document()?)?;
        let budget = CapacityCounter::from_integer(capacity.budget())?;
        let committed = CapacityCounter::from_integer(capacity.total())?;
        let retained = CapacityCounter::from_integer(&retained)?;
        need(
            pool_headroom_fits(budget, committed, retained, CapacityCounter::try_new(0)?)?,
            "RESERVATION_CAPACITY_EXHAUSTED",
        )?;
        need(
            native.inventory(None)?.equivalent(&rows),
            "RESERVATION_NATIVE_INVENTORY_CHANGED",
        )?;
        Ok(HeadroomFacts {
            budget_bytes: budget.get(),
            committed_bytes: committed.get(),
            retained_bytes: retained.get(),
        })
    }
}
