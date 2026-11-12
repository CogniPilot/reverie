//! Reach the private exact-original cleanup binder ONLY from the genuine
//! same-Q authorization producer. This never interrupts or stops a handler.
use super::*;
use crate::reservation_gate::PoolTransitionFence;
use reverie_host::worker_reports::WorkerOriginalHandlersDrain;

impl AuthenticatedFleetMaintenance<'_> {
    pub(crate) fn fleet_stop_targets(
        &mut self,
    ) -> std::result::Result<Vec<WorkerContainerName>, GateError> {
        let body = self
            .owner
            .coverage
            .as_ref()
            .expect("approved original coverage")
            .stop_targets();
        self.owner
            .retain_check(body)
            .map_err(|error| GateError::Refused(error.code()))
    }
    pub(crate) fn assert_fleet_stop_inventory(
        &mut self,
        rows: &crate::reservation_observer::ObservedInventory,
    ) -> std::result::Result<(), GateError> {
        let body = if self
            .owner
            .coverage
            .as_ref()
            .expect("approved original coverage")
            .same_inventory(rows)
        {
            Ok(())
        } else {
            Err(Cause::Refused("FLEET_PREVIEW_CENSUS_CHANGED"))
        };
        self.owner
            .retain_check(body)
            .map_err(|error| GateError::Refused(error.code()))
    }
    pub(crate) fn fleet_stop_deadline(&self) -> Instant {
        self.owner.original_end()
    }
    /// Metadata-only inside the actual R scope. The original local typed cause
    /// stays with this same authorization; shared Gate errors remain Send+Sync.
    pub(crate) fn assert_fleet_stop_gate(
        &mut self,
        gate: &crate::reservation_gate::ReservationGate,
    ) -> std::result::Result<(), GateError> {
        let checked = self
            .assert_reservation_gate(gate)
            .and_then(|()| self.assert_live());
        checked.map_err(|error| {
            let code = error.code();
            self.owner.primary.get_or_insert(error.cause);
            GateError::Refused(code)
        })
    }
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
