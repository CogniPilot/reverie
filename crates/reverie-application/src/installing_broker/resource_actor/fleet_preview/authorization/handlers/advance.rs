//! A continuation of the original interrupted selection, never new capture or
//! replay of rows whose actual shutdown was already issued.
use super::*;
use reverie_host::worker_reports::WorkerOriginalInterruptionProgress;

impl AuthenticatedFleetMaintenance<'_> {
    pub fn advance_original_handlers(
        &mut self,
        fence: &PoolTransitionFence,
        drain: &mut WorkerOriginalHandlersDrain,
    ) -> std::result::Result<WorkerOriginalInterruptionProgress, FleetMaintenanceCheckError> {
        if let Some(cause) = &self.owner.primary {
            return Err(FleetMaintenanceCheckError::retained(cause));
        }
        let checked = self.assert_interrupted_selection(fence, &drain.cleanup_binding());
        self.owner.retain_check(checked)?;
        let checked = fence
            .assert_handlers_outside_admission()
            .map_err(Into::into);
        self.owner.retain_check(checked)?;
        let checked =
            (|| {
                self.owner.assert_interruption_native()?;
                let now = owner::epoch()?;
                if self.owner.maintenance_owner.as_ref().is_none_or(|current| {
                    current.expires_at_epoch_ms() <= now.saturating_add(1_000)
                }) {
                    self.owner.refresh_maintenance_owner()?;
                    self.owner.assert_interruption_native()?;
                }
                self.owner.assert_maintenance_live()
            })();
        self.owner.retain_check(checked)?;
        let frame = self.owner.frame.as_ref().expect("same original Q");
        let checked = drain
            .advance_interruption(
                channel(frame).map_err(|cause| FleetMaintenanceCheckError {
                    cause: Rc::new(cause),
                })?,
                &frame.broker.reports,
                &frame.broker.storage.runtime,
            )
            .map_err(Cause::OriginalHandlers);
        self.owner.retain_check(checked)
    }
}
