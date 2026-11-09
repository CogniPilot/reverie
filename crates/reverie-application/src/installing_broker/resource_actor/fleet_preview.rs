//! Actual readonly fleet Q consumer. Native observations remain owned here;
//! the reply explicitly requires target verification and grants no effects.
use super::*;
use crate::installing_broker::installation_offer;
use std::rc::Rc;
mod close;
mod coverage;
mod error;
mod owner;
mod target;
#[cfg(test)]
mod tests;
use error::Cause;
use target::TargetAttempt;
type Result<T, E = Cause> = std::result::Result<T, E>;

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
    closed: bool,
}
pub(in crate::installing_broker) struct FleetPreviewFailure<'a> {
    owner: NativeFleetPreview<'a>,
}
pub(in crate::installing_broker) struct FleetPreviewClosed {
    primary: Option<Rc<Cause>>,
    target_cleanup: Option<Rc<Cause>>,
    frame_cleanup: Option<Rc<Cause>>,
}
impl FleetPreviewClosed {
    pub(in crate::installing_broker) fn primary_error_code(&self) -> Option<&'static str> {
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
        let mut owner = NativeFleetPreview {
            frame: Some(Frame::incoming(
                self,
                connection,
                WebsitePurpose::FleetPreview,
                Instant::now() + Duration::from_secs(300),
            )),
            target: Some(TargetAttempt::Offer(offer)),
            request: None,
            viewer: None,
            coverage: None,
            selection: None,
            primary: None,
            target_cleanup: None,
            frame_cleanup: None,
            closed: false,
        };
        if let Err(cause) = owner.prepare(self).and_then(|()| owner.send_observed()) {
            owner.primary = Some(Rc::new(cause));
        }
        Box::new(FleetPreviewFailure { owner }).settle_for_worker()
    }
}
impl FleetPreviewFailure<'_> {
    pub(in crate::installing_broker) fn settle_for_worker(
        mut self: Box<Self>,
    ) -> Result<FleetPreviewClosed, Box<Self>> {
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
            std::mem::forget(self.primary.take());
            std::mem::forget(self.target_cleanup.take());
            std::mem::forget(self.frame_cleanup.take());
        }
    }
}
