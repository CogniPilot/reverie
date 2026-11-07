//! Every actual Created/Reuse J scope survives EVERY relay exit for finally:
//! fresh receipt classification and actual stop precede native viewer reap.
use super::*;
use reverie_host::{
    worker_laptop::ViewerSession,
    worker_reports::{ViewerRelayEnd, ViewerRelayError, ViewerRelayEvent},
};

#[derive(Debug)]
pub enum ReuseRelayError {
    Configuration(GateError),
    Transport(ViewerRelayError),
}
/// Both real owners share this failure representation; keep the existing
/// Reuse enum identity and variant imports compatible.
pub type WorkerViewerRelayError = ReuseRelayError;

#[must_use = "retain the whole viewer/J/Hold/claim for original finalization"]
pub struct ReuseRelayReturned<'a> {
    viewing: ViewingReuse<'a>,
    outcome: Result<ViewerRelayEnd, ReuseRelayError>,
}
impl<'a> ReuseRelayReturned<'a> {
    /// No finalization or resource reconstruction occurs at this handoff.
    pub fn into_parts(self) -> (ViewingReuse<'a>, Result<ViewerRelayEnd, ReuseRelayError>) {
        (self.viewing, self.outcome)
    }
}
#[must_use = "retain the whole created scope/J/Hold/started owner for finally"]
pub struct ColdRelayReturned<'a> {
    viewing: ViewingCold<'a>,
    outcome: Result<ViewerRelayEnd, WorkerViewerRelayError>,
}
impl<'a> ColdRelayReturned<'a> {
    /// Every outcome returns the exact actual owner that entered relay. EOF,
    /// X, intent change and errors select no cleanup/release shortcut here.
    pub fn into_parts(
        self,
    ) -> (
        ViewingCold<'a>,
        Result<ViewerRelayEnd, WorkerViewerRelayError>,
    ) {
        (self.viewing, self.outcome)
    }
}
impl<'a> ViewingReuse<'a> {
    pub fn relay(self) -> ReuseRelayReturned<'a> {
        let outcome = drive_relay(
            self.broker(),
            self.relay_connection(),
            self.viewer_session(),
        );
        ReuseRelayReturned {
            viewing: self,
            outcome,
        }
    }
}
impl<'a> ViewingCold<'a> {
    pub fn relay(self) -> ColdRelayReturned<'a> {
        let outcome = drive_relay(
            self.broker(),
            self.relay_connection(),
            self.viewer_session(),
        );
        ColdRelayReturned {
            viewing: self,
            outcome,
        }
    }
}
fn drive_relay(
    broker: &InstallingBroker,
    connection: &WorkerLaunchConnection,
    session: &ViewerSession,
) -> Result<ViewerRelayEnd, WorkerViewerRelayError> {
    let mut relay = connection
        .begin_viewer_relay(&broker.storage.runtime, session)
        .map_err(WorkerViewerRelayError::Transport)?;
    loop {
        let event = relay.step().map_err(WorkerViewerRelayError::Transport)?;
        let event = if matches!(event, ViewerRelayEvent::CheckCurrentIntent) {
            let current = broker
                .configuration()
                .map_err(WorkerViewerRelayError::Configuration)?;
            relay
                .check_current_intent(current.configuration())
                .map_err(WorkerViewerRelayError::Transport)?
        } else {
            event
        };
        if let ViewerRelayEvent::Ended(reason) = event {
            return Ok(reason);
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
