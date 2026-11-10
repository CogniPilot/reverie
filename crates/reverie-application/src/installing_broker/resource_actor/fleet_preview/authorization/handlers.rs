//! Same original Q/selection forward once; settlement never renews authority.
use super::*;
use crate::reservation_gate::PoolTransitionFence;
use reverie_host::worker_reports::{
    WorkerHandlersProgress, WorkerOriginalHandlersCleanupBinding, WorkerOriginalHandlersClosed,
    WorkerOriginalHandlersDrain,
};
mod advance;

pub(super) enum OriginalHandlersPhase {
    Uncaptured,
    Captured(WorkerOriginalHandlersCleanupBinding),
    Interrupted(WorkerOriginalHandlersCleanupBinding),
}
impl AuthenticatedFleetMaintenance<'_> {
    pub fn retain_original_handlers(
        &mut self,
    ) -> std::result::Result<WorkerOriginalHandlersDrain, FleetMaintenanceCheckError> {
        self.assert_current()?;
        let body = (|| {
            if !matches!(self.handlers, OriginalHandlersPhase::Uncaptured) {
                return Err(Cause::Refused("FLEET_MAINTENANCE_HANDLER_CAPTURE_REPLAYED"));
            }
            let frame = self.owner.frame.as_ref().expect("same authorized Q");
            let drain = channel(frame)?
                .retain_other_original_handlers(
                    &frame.broker.reports,
                    &frame.broker.storage.runtime,
                    self.owner.original_end(),
                )
                .map_err(ResourceActorError::from)?;
            self.handlers = OriginalHandlersPhase::Captured(drain.cleanup_binding());
            Ok(drain)
        })();
        self.owner.retain_check(body)
    }
    /// Start one original interruption operation. Pending may only advance
    /// through advance_original_handlers on these SAME retained selected rows.
    pub fn interrupt_original_handlers(
        &mut self,
        fence: &PoolTransitionFence,
        drain: &mut WorkerOriginalHandlersDrain,
    ) -> std::result::Result<WorkerHandlersProgress, FleetMaintenanceCheckError> {
        let body = self.assert_captured_selection(fence, drain);
        self.owner.retain_check(body)?;
        self.assert_current()?;
        self.handlers = OriginalHandlersPhase::Interrupted(drain.cleanup_binding());
        let frame = self.owner.frame.as_ref().expect("same authorized Q");
        let body = drain
            .interrupt(
                channel(frame).map_err(|cause| FleetMaintenanceCheckError {
                    cause: Rc::new(cause),
                })?,
                &frame.broker.reports,
                &frame.broker.storage.runtime,
            )
            .map_err(Cause::OriginalHandlers);
        self.owner.retain_check(body)
    }
    /// Original cleanup only, including after Q loss/expiry. No owner refresh,
    /// new capture, interrupt, admission or renewed budget occurs here.
    pub fn settle_original_handlers(
        &mut self,
        fence: &PoolTransitionFence,
        drain: &mut WorkerOriginalHandlersDrain,
    ) -> std::result::Result<WorkerHandlersProgress, FleetMaintenanceCheckError> {
        let checked = self.assert_interrupted_selection(fence, &drain.cleanup_binding());
        self.owner.retain_check(checked)?;
        let checked = fence
            .assert_handlers_outside_admission()
            .map_err(Into::into);
        self.owner.retain_check(checked)?;
        let runtime = &self
            .owner
            .frame
            .as_ref()
            .expect("same Q origin")
            .broker
            .storage
            .runtime;
        drain
            .settle(runtime)
            .map_err(|cause| FleetMaintenanceCheckError {
                cause: Rc::new(Cause::OriginalHandlers(cause)),
            })
    }
    fn assert_captured_selection(
        &self,
        fence: &PoolTransitionFence,
        drain: &WorkerOriginalHandlersDrain,
    ) -> Result<()> {
        let OriginalHandlersPhase::Captured(binding) = &self.handlers else {
            return Err(Cause::Refused(
                "FLEET_MAINTENANCE_HANDLER_INTERRUPT_REPLAYED",
            ));
        };
        binding
            .assert_same_selection(&drain.cleanup_binding())
            .map_err(GateError::from)?;
        self.assert_handler_binding(fence, binding)?;
        fence.assert_cleanup_selection(binding)?;
        Ok(())
    }
    pub(super) fn assert_closed_handlers(
        &self,
        fence: &PoolTransitionFence,
        closed: &WorkerOriginalHandlersClosed,
    ) -> Result<()> {
        self.assert_interrupted_selection(fence, &closed.cleanup_binding())?;
        fence.assert_cleanup_selection(&closed.cleanup_binding())?;
        Ok(())
    }
    pub(super) fn assert_interrupted_selection(
        &self,
        fence: &PoolTransitionFence,
        other: &WorkerOriginalHandlersCleanupBinding,
    ) -> Result<()> {
        let OriginalHandlersPhase::Interrupted(binding) = &self.handlers else {
            return Err(Cause::Refused(
                "FLEET_MAINTENANCE_HANDLER_INTERRUPT_REQUIRED",
            ));
        };
        binding
            .assert_same_selection(other)
            .map_err(GateError::from)?;
        self.assert_handler_binding(fence, binding)
    }
    fn assert_handler_binding(
        &self,
        fence: &PoolTransitionFence,
        binding: &WorkerOriginalHandlersCleanupBinding,
    ) -> Result<()> {
        let frame = self.owner.frame.as_ref().expect("same authorized Q");
        let gate = frame
            .broker
            .resource_reservations()?
            .ok_or(Cause::Refused("POOL_TRANSITION_GATE_REQUIRED"))?;
        fence.assert_gate(gate)?;
        fence.assert_selection(self.selection())?;
        binding
            .assert_owner(
                channel(frame)?,
                &frame.broker.reports,
                &frame.broker.storage.runtime,
            )
            .map_err(GateError::from)?;
        fence.assert_cleanup_provenance(binding)?;
        Ok(())
    }
}
fn channel<'frame>(frame: &'frame Frame<'_>) -> Result<&'frame WorkerActorChannel> {
    match &frame.transport {
        Transport::Retained(channel) => Ok(channel),
        _ => Err(Cause::Refused("RESOURCE_ACTOR_CHANNEL_STATE")),
    }
}
