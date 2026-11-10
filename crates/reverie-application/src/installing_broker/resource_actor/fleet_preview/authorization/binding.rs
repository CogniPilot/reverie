//! Reach the private exact-original cleanup binder ONLY from the genuine
//! same-Q authorization producer. This never interrupts or stops a handler.
use super::*;
use crate::reservation_gate::PoolTransitionFence;
use reverie_host::worker_reports::WorkerOriginalHandlersDrain;

impl AuthenticatedFleetMaintenance<'_> {
    /// Recheck outside admission, match all six original references, then
    /// bind the same captured records to the same native denial fence. The
    /// caller retains both original fence and drain on every failure.
    pub fn bind_original_cleanup(
        &mut self,
        fence: &mut PoolTransitionFence,
        drain: &WorkerOriginalHandlersDrain,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        self.assert_current()?;
        let body = (|| {
            fence.assert_selection(self.selection())?;
            self.owner.assert_maintenance_live()?;
            let frame = self
                .owner
                .frame
                .as_ref()
                .expect("same authorized Q retained");
            let Transport::Retained(channel) = &frame.transport else {
                return Err(Cause::Refused("RESOURCE_ACTOR_CHANNEL_STATE"));
            };
            frame
                .broker
                .bind_pool_original_cleanup(fence, channel, drain)?;
            self.owner.assert_maintenance_live()
        })();
        self.owner.retain_check(body)
    }
}
