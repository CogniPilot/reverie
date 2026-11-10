use super::*;

impl Inner {
    pub(in crate::reservation_gate) fn admit_transition_fleet_cleanup(
        self: &Arc<Self>,
        cleanup: pool_transition::OriginalCleanupAdmission,
        budget: &reverie_host::worker_runtime::WorkerStopBudget,
        end: Instant,
    ) -> Result<Admission> {
        let bounds = AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        };
        let end = bounds.validate()?;
        let entry = self.reserve_selected_entry(end, Some(cleanup))?;
        self.enter_reserved(bounds, end, None, Some(budget), entry)
    }
}
