//! Actual readonly fleet Q consumer. Native observations remain owned here;
//! the reply explicitly requires target verification and grants no effects.
use super::*;
use crate::installing_broker::installation_offer;
use std::rc::Rc;
mod authorization;
mod close;
mod coverage;
mod error;
mod inputs;
mod owner;
mod qualified;
mod target;
#[cfg(test)]
mod tests;
pub use authorization::{AuthenticatedFleetMaintenance, FleetMaintenanceCheckError};
use error::Cause;
pub use qualified::QualifiedFleetPreview;
use target::TargetAttempt;
type Result<T, E = Cause> = std::result::Result<T, E>;
const OWNER_FRESHNESS_MILLIS: u64 = 10_000;

pub(super) struct NativeFleetPreview<'a> {
    frame: Option<Frame<'a>>,
    target: Option<TargetAttempt>,
    request: Option<FleetPreviewRequest>,
    viewer: Option<CurrentFleetPreviewViewer>,
    coverage: Option<coverage::Coverage<'a>>,
    selection: Option<reverie_contracts::reservation_control::PoolTransitionSelection>,
    primary: Option<Rc<Cause>>,
    target_cleanup: Option<Rc<Cause>>,
    frame_cleanup: Option<Rc<Cause>>,
    inputs: Option<inputs::PoolInputs>,
    maintenance_request: Option<FleetMaintenanceRequest>,
    maintenance_owner: Option<CurrentFleetMaintenanceOwner>,
    maintenance_checks: usize,
    closed: bool,
}
pub struct FleetPreviewFailure<'a> {
    owner: NativeFleetPreview<'a>,
}
pub struct FleetPreviewClosed {
    primary: Option<Rc<Cause>>,
    target_cleanup: Option<Rc<Cause>>,
    frame_cleanup: Option<Rc<Cause>>,
}
impl FleetPreviewClosed {
    pub fn primary_error_code(&self) -> Option<&'static str> {
        self.primary
            .as_ref()
            .or(self.target_cleanup.as_ref())
            .or(self.frame_cleanup.as_ref())
            .map(|e| e.code())
    }
}
impl std::fmt::Display for FleetPreviewClosed {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("FLEET_PREVIEW_COMPONENT_CLOSED")?;
        for cause in [&self.primary, &self.target_cleanup, &self.frame_cleanup]
            .into_iter()
            .flatten()
        {
            write!(out, ": {cause}")?;
        }
        Ok(())
    }
}
impl InstallingBroker {
    pub(in crate::installing_broker) fn handle_fleet_preview<'a>(
        self: &'a Arc<Self>,
        connection: WorkerServiceConnection,
        offer: Option<installation_offer::SharedInstallationOffer>,
    ) -> Result<FleetPreviewClosed, Box<FleetPreviewFailure<'a>>> {
        // Both actual producers are retained before any fallible read/retain.
        let mut owner = NativeFleetPreview::incoming(self, connection, TargetAttempt::Offer(offer));
        if let Err(cause) = owner.prepare(self).and_then(|()| owner.send_observed()) {
            owner.primary = Some(Rc::new(cause));
        }
        Box::new(FleetPreviewFailure { owner }).settle_for_worker()
    }
}
impl<'a> NativeFleetPreview<'a> {
    fn incoming(
        broker: &'a Arc<InstallingBroker>,
        connection: WorkerServiceConnection,
        target: TargetAttempt,
    ) -> Self {
        Self {
            frame: Some(Frame::incoming(
                broker,
                connection,
                WebsitePurpose::FleetPreview,
                Instant::now() + Duration::from_secs(300),
            )),
            target: Some(target),
            request: None,
            viewer: None,
            coverage: None,
            selection: None,
            primary: None,
            target_cleanup: None,
            frame_cleanup: None,
            inputs: None,
            maintenance_request: None,
            maintenance_owner: None,
            maintenance_checks: 0,
            closed: false,
        }
    }
}
impl FleetPreviewFailure<'_> {
    pub(in crate::installing_broker) fn settle_for_worker(
        self: Box<Self>,
    ) -> Result<FleetPreviewClosed, Box<Self>> {
        self.close()
    }
    pub fn primary_error_code(&self) -> Option<&'static str> {
        self.owner.primary.as_ref().map(|cause| cause.code())
    }
    /// Immutable local diagnostic over the same original typed cause. It is
    /// intentionally thread-confined and must not enter shared GateError.
    pub fn primary_error(&self) -> Option<FleetMaintenanceCheckError> {
        self.owner
            .primary
            .as_ref()
            .map(FleetMaintenanceCheckError::retained)
    }
    /// Settle only these original frame/query components. This never drains
    /// employees, releases an installation offer or acknowledges a resource.
    pub fn close(mut self: Box<Self>) -> Result<FleetPreviewClosed, Box<Self>> {
        if self.owner.close_components().is_err() {
            return Err(self);
        }
        Ok(FleetPreviewClosed {
            primary: self.owner.primary.take(),
            target_cleanup: self.owner.target_cleanup.take(),
            frame_cleanup: self.owner.frame_cleanup.take(),
        })
    }
}
impl std::fmt::Display for FleetPreviewFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("FLEET_PREVIEW_RETAINED")?;
        for cause in [
            &self.owner.primary,
            &self.owner.target_cleanup,
            &self.owner.frame_cleanup,
        ]
        .into_iter()
        .flatten()
        {
            write!(out, ": {cause}")?;
        }
        Ok(())
    }
}
impl Drop for NativeFleetPreview<'_> {
    fn drop(&mut self) {
        if !self.closed {
            std::mem::forget(self.frame.take());
            std::mem::forget(self.target.take());
            std::mem::forget(self.coverage.take());
            std::mem::forget(self.inputs.take());
            std::mem::forget(self.request.take());
            std::mem::forget(self.viewer.take());
            std::mem::forget(self.selection.take());
            std::mem::forget(self.maintenance_request.take());
            std::mem::forget(self.maintenance_owner.take());
            std::mem::forget(self.primary.take());
            std::mem::forget(self.target_cleanup.take());
            std::mem::forget(self.frame_cleanup.take());
        }
    }
}
