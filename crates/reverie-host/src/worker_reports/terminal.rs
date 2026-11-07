//! Serial I/R/O/X transport on the original accepted J and actual viewer. A
//! terminal outcome never closes the viewer/storage/handler or grants stop.
mod error;
mod identity;
mod resize;
pub(super) mod socket;
mod step;
#[cfg(test)]
pub(crate) mod test_hooks;
use super::*;
use crate::worker_laptop::ViewerSession;
pub use error::ViewerRelayError;
pub(crate) use identity::RelayIdentity;
use resize::Resize;
use reverie_core::{
    ids::{ContainerId, ProfileSessionId},
    posix_path::PosixPath,
};
use std::time::Duration;
type RelayResult<T> = std::result::Result<T, ViewerRelayError>;

pub enum ViewerRelayEnd {
    Receipt(Vec<u8>),
    ViewerExited(i32),
    PeerClosed,
    Stopping,
    IntentChanged,
}
pub enum ViewerRelayEvent {
    Progress,
    CheckCurrentIntent,
    Ended(ViewerRelayEnd),
}
#[must_use = "retain the whole App J/active/resource owner for actual finalization"]
pub struct ViewerRelay<'a> {
    connection: &'a WorkerLaunchConnection,
    runtime: &'a WorkerRuntime,
    viewer: &'a ViewerSession,
    identity: RelayIdentity,
    attached: Instant,
    checked: Instant,
    await_intent: bool,
    ended: bool,
    master_open: bool,
    checked_completed: bool,
    resize: Resize,
}
pub(crate) struct RelayTarget {
    pub(crate) session: ProfileSessionId,
    pub(crate) exit: PosixPath,
    pub(crate) container: Option<ContainerId>,
}
#[derive(Clone, Copy)]
pub(crate) enum TerminalWait {
    Read { master: bool },
    Input,
}
#[derive(Default)]
pub(crate) struct TerminalReady {
    pub(crate) connection: bool,
    pub(crate) master: bool,
}
pub(crate) enum TerminalObservation {
    Value(String),
    Missed,
    Unavailable,
    CleanupUnconfirmed,
}
impl WorkerLaunchConnection {
    /// The actual App caller must already have released its real allocation
    /// admission/lifecycle; this method constructs no release proof.
    pub fn begin_viewer_relay<'a>(
        &'a self,
        runtime: &'a WorkerRuntime,
        viewer: &'a ViewerSession,
    ) -> RelayResult<ViewerRelay<'a>> {
        self.assert_open(runtime)?;
        self.require_terminal_hold()?;
        let identity = self.terminal_identity();
        runtime.bind_terminal_viewer(viewer, &identity, self.request().session())?;
        let now = Instant::now();
        Ok(ViewerRelay {
            connection: self,
            runtime,
            viewer,
            identity,
            attached: now,
            checked: now,
            await_intent: false,
            ended: false,
            master_open: true,
            checked_completed: false,
            resize: Resize::default(),
        })
    }
}
impl ViewerRelay<'_> {
    /// Current config comes from the real App snapshot. There is no allow-bit
    /// setter or callback: the fixed source reader performs the actual check.
    pub fn check_current_intent(
        &mut self,
        current: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> RelayResult<ViewerRelayEvent> {
        let result = self.current_intent_inner(current);
        match result {
            Ok(event) => Ok(event),
            Err(error) => self.fail(error),
        }
    }
    fn current_intent_inner(
        &mut self,
        current: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> RelayResult<ViewerRelayEvent> {
        if self.ended || !self.await_intent {
            return Err(ViewerRelayError::Phase);
        }
        self.connection.assert_open(self.runtime)?;
        let allowed =
            crate::worker_intent::read_allowed(current, self.connection.request().session())
                .map_err(ViewerRelayError::Intent)?;
        self.await_intent = false;
        self.checked = Instant::now();
        if !allowed {
            self.ended = true;
            return Ok(ViewerRelayEvent::Ended(ViewerRelayEnd::IntentChanged));
        }
        self.check_dead_pane()?;
        Ok(ViewerRelayEvent::Progress)
    }
    pub fn step(&mut self) -> RelayResult<ViewerRelayEvent> {
        if self.ended {
            return Err(ViewerRelayError::Phase);
        }
        if self.await_intent {
            return Ok(ViewerRelayEvent::CheckCurrentIntent);
        }
        let result = self.step_inner();
        match result {
            Ok(event) => Ok(event),
            Err(error) if error.busy() => {
                #[cfg(test)]
                test_hooks::saw_busy();
                std::thread::sleep(Duration::from_millis(1));
                Ok(ViewerRelayEvent::Progress)
            }
            Err(error) if error.quiet_disconnect() => {
                self.ended = true;
                Ok(ViewerRelayEvent::Ended(ViewerRelayEnd::PeerClosed))
            }
            Err(error) => self.fail(error),
        }
    }
    fn fail<T>(&mut self, error: ViewerRelayError) -> RelayResult<T> {
        self.ended = true;
        let sent = self
            .connection
            .terminal_socket()
            .and_then(|mut stream| stream.error(&error.to_string()))
            .map_err(ViewerRelayError::Transport);
        match sent {
            Ok(()) => Err(error),
            Err(secondary) => Err(ViewerRelayError::Finalization {
                primary: Box::new(error),
                secondary: Box::new(secondary),
            }),
        }
    }
    fn stop_bound(&self, end: Instant) -> Instant {
        self.runtime
            .stop_deadline()
            .map_or(end, |stop| stop.min(end))
    }
}
