//! The existing stop consumer's live bound, not a clock/authority selector.
use super::*;
use reverie_host::worker_runtime::WorkerStopBudget;
impl ObservationContext {
    /// Preserve observer, cancellation and census origin; a second service
    /// cannot replace the actual view already inherited by this context.
    pub(crate) fn inherit_worker_stop_budget(&mut self, budget: &WorkerStopBudget) -> Result<()> {
        need(
            self.stop_budget
                .as_ref()
                .is_none_or(|old| old.same_origin(budget)),
            "RESERVATION_STOP_CONTEXT_ORIGIN",
        )?;
        self.stop_budget = Some(budget.clone());
        Ok(())
    }
    pub(super) fn live_stop_deadline(&self) -> Option<Instant> {
        self.stop_budget
            .as_ref()
            .and_then(WorkerStopBudget::deadline)
    }
}
