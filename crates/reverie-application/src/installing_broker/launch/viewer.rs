//! The whole classified J scope survives EVERY relay exit for the real outer
//! finalizer: fresh receipt classification and stop precede viewer reap.
use super::*;
use reverie_host::worker_reports::{ViewerRelayEnd, ViewerRelayError, ViewerRelayEvent};

#[derive(Debug)]
pub enum ReuseRelayError {
    Configuration(GateError),
    Transport(ViewerRelayError),
}
#[must_use = "retain the whole viewer/J/Hold/claim for original finalization"]
pub struct ReuseRelayReturned<'a> {
    viewing: ViewingReuse<'a>,
    outcome: Result<ViewerRelayEnd, ReuseRelayError>,
}
impl<'a> ReuseRelayReturned<'a> {
    /// No finalization, resource reconstruction or receipt-derived permission
    /// occurs here. The returned owner is exactly the one that entered relay.
    pub fn into_parts(self) -> (ViewingReuse<'a>, Result<ViewerRelayEnd, ReuseRelayError>) {
        (self.viewing, self.outcome)
    }
}
impl<'a> ViewingReuse<'a> {
    pub fn relay(self) -> ReuseRelayReturned<'a> {
        let outcome = self.drive_relay();
        ReuseRelayReturned {
            viewing: self,
            outcome,
        }
    }
    fn drive_relay(&self) -> Result<ViewerRelayEnd, ReuseRelayError> {
        let mut relay = self
            .relay_connection()
            .begin_viewer_relay(&self.broker().storage.runtime, self.viewer_session())
            .map_err(ReuseRelayError::Transport)?;
        loop {
            let event = relay.step().map_err(ReuseRelayError::Transport)?;
            match event {
                ViewerRelayEvent::Progress => {}
                ViewerRelayEvent::Ended(reason) => return Ok(reason),
                ViewerRelayEvent::CheckCurrentIntent => {
                    let current = self
                        .broker()
                        .configuration()
                        .map_err(ReuseRelayError::Configuration)?;
                    if let ViewerRelayEvent::Ended(reason) = relay
                        .check_current_intent(current.configuration())
                        .map_err(ReuseRelayError::Transport)?
                    {
                        return Ok(reason);
                    }
                }
            }
        }
    }
}
impl std::fmt::Display for ReuseRelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Configuration(error) => error.fmt(f),
            Self::Transport(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for ReuseRelayError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Configuration(error) => Some(error),
            Self::Transport(error) => Some(error),
        }
    }
}
