//! Actual selected-Q/fence/closed-handler bridge to the original C stop owners.
//! Success retains lifecycle denial and the same pending fence for the next
//! owning publication stage; this module cannot activate or release the pool.
use super::*;
use crate::{
    installing_broker::fleet_drain::{DrainCause, LegacyFleetDrain},
    reservation_gate::PoolTransitionFence,
};
use reverie_host::worker_reports::WorkerOriginalHandlersClosed;

struct Owner<'a> {
    authorization: AuthenticatedFleetMaintenance<'a>,
    broker: &'a Arc<InstallingBroker>,
    _retained_broker: Arc<InstallingBroker>,
    fence: PoolTransitionFence,
    handlers: WorkerOriginalHandlersClosed,
    drain: LegacyFleetDrain<'a>,
}
/// Deployment-scoped actual stopped/closed legacy resources, not a whole-host
/// capacity or activated-parent certificate. No copied DATA constructor exists.
#[must_use = "retain the original auth/fence/lifecycle until owning publication"]
pub struct DrainedLegacyFleet<'a> {
    owner: Option<Box<Owner<'a>>>,
}
pub struct LegacyFleetDrainError(DrainCause);
impl LegacyFleetDrainError {
    pub fn code(&self) -> &'static str {
        self.0.code()
    }
}
impl std::fmt::Debug for LegacyFleetDrainError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("LegacyFleetDrainError")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for LegacyFleetDrainError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for LegacyFleetDrainError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}
#[must_use = "retain all original owners and typed causes; never replay a failed drain"]
pub struct LegacyFleetDrainFailure<'a> {
    owner: Option<Box<Owner<'a>>>,
    primary: Option<LegacyFleetDrainError>,
    cleanup: Option<LegacyFleetDrainError>,
    settled: bool,
}
impl<'a> AuthenticatedFleetMaintenance<'a> {
    /// Original jobs must already have joined, without R, through this SAME
    /// authorization's one-shot interruption and opaque closed selection.
    pub fn drain_legacy_fleet(
        self,
        broker: &'a Arc<InstallingBroker>,
        fence: PoolTransitionFence,
        handlers: WorkerOriginalHandlersClosed,
    ) -> std::result::Result<DrainedLegacyFleet<'a>, Box<LegacyFleetDrainFailure<'a>>> {
        let end = self.owner.original_end();
        // Consume every original owner before the first fallible validation.
        let mut owner = Box::new(Owner {
            authorization: self,
            broker,
            _retained_broker: Arc::clone(broker),
            fence,
            handlers,
            drain: LegacyFleetDrain::new(broker, end),
        });
        match owner.run() {
            Ok(()) => Ok(DrainedLegacyFleet { owner: Some(owner) }),
            Err(primary) => Err(Box::new(LegacyFleetDrainFailure {
                owner: Some(owner),
                primary: Some(LegacyFleetDrainError(primary)),
                cleanup: None,
                settled: false,
            })),
        }
    }
    fn assert_after_original_handlers(
        &mut self,
        fence: &PoolTransitionFence,
        handlers: &WorkerOriginalHandlersClosed,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        if let Some(cause) = &self.owner.primary {
            return Err(FleetMaintenanceCheckError::retained(cause));
        }
        let checked = self.assert_closed_handlers(fence, handlers);
        self.owner.retain_check(checked)?;
        let body = self
            .owner
            .assert_post_handler_native()
            .and_then(|()| self.owner.refresh_maintenance_owner())
            .and_then(|()| self.owner.assert_post_handler_native())
            .and_then(|()| self.owner.assert_maintenance_live());
        self.owner.retain_check(body)
    }
}
impl NativeFleetPreview<'_> {
    fn assert_post_handler_native(&mut self) -> Result<()> {
        let end = self.original_end();
        self.frame
            .as_mut()
            .expect("same original Q")
            .guard_bootstrap(end)?;
        self.assert_binding()?;
        self.coverage
            .as_ref()
            .expect("approved original coverage")
            .assert_after_original_handlers(self.frame.as_mut().expect("same Q"), end)?;
        self.compare_fixed_images()?;
        self.assert_inputs_current()?;
        self.assert_maintenance_live()
    }
}
impl Owner<'_> {
    fn run(&mut self) -> std::result::Result<(), DrainCause> {
        let original = self
            .authorization
            .owner
            .frame
            .as_ref()
            .expect("same authorized Q")
            .broker;
        if !std::ptr::eq(original, self.broker.as_ref()) {
            return Err(DrainCause::Refused("FLEET_MAINTENANCE_BROKER_CHANGED"));
        }
        self.authorization
            .assert_after_original_handlers(&self.fence, &self.handlers)
            .map_err(DrainCause::Authorization)?;
        self.drain
            .run_transition(&mut self.authorization, &self.fence, &self.handlers)
    }
}
impl DrainedLegacyFleet<'_> {
    pub fn selection(&self) -> &reverie_contracts::reservation_control::PoolTransitionSelection {
        self.owner
            .as_ref()
            .expect("same drained owner")
            .authorization
            .selection()
    }
    pub fn operation_id(&self) -> &reverie_core::operations::JournalId {
        self.owner
            .as_ref()
            .expect("same drained owner")
            .fence
            .operation_id()
    }
    pub fn original_handler_causes(
        &self,
    ) -> &[Rc<reverie_host::worker_reports::WorkerReportError>] {
        self.owner
            .as_ref()
            .expect("same drained owner")
            .handlers
            .original_causes()
    }
}
impl LegacyFleetDrainFailure<'_> {
    pub fn primary_error(&self) -> &LegacyFleetDrainError {
        self.primary.as_ref().expect("original cause")
    }
    pub fn cleanup_error(&self) -> Option<&LegacyFleetDrainError> {
        self.cleanup.as_ref()
    }
    /// One bounded original-ticket settlement pass only. This cannot issue a
    /// new stop, mint success, close Q, undo lifecycle denial or release pending.
    pub fn settle_components(&mut self) -> std::result::Result<(), &LegacyFleetDrainError> {
        if !self.settled {
            self.settled = true;
            let mut causes = self
                .owner
                .as_mut()
                .expect("same retained owner")
                .drain
                .settle_components()
                .into_iter();
            if let Some(first) = causes.next() {
                let cause = causes.fold(first, |primary, secondary| DrainCause::Finalization {
                    primary: Box::new(primary),
                    secondary: Box::new(secondary),
                });
                self.cleanup = Some(LegacyFleetDrainError(cause));
            }
        }
        self.cleanup.as_ref().map_or(Ok(()), Err)
    }
}
impl std::fmt::Debug for LegacyFleetDrainFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("LegacyFleetDrainFailure")
            .field(self.primary_error())
            .finish()
    }
}
impl std::fmt::Display for LegacyFleetDrainFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.primary_error().fmt(out)?;
        if let Some(cleanup) = &self.cleanup {
            write!(out, "; cleanup: {cleanup}")?;
        }
        Ok(())
    }
}
impl std::error::Error for LegacyFleetDrainFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.primary_error())
    }
}
impl Drop for DrainedLegacyFleet<'_> {
    fn drop(&mut self) {
        std::mem::forget(self.owner.take());
    }
}
impl Drop for LegacyFleetDrainFailure<'_> {
    fn drop(&mut self) {
        std::mem::forget((self.owner.take(), self.primary.take(), self.cleanup.take()));
    }
}
