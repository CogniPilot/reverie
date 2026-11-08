//! Credential-checked transport for the fixed website and host-resume actors.
//! This is the original counted Record, not a process, file or action grant.
//! Domain owners must qualify the installed program and recheck its process
//! before and after every receive chunk; no verifier callback is accepted here.
mod current_pin;
mod io;
pub use current_pin::WorkerActorPinError;
mod pool_registration;
pub use pool_registration::PoolRegistrationPin;
mod resource_journal;
pub use resource_journal::{ResourceJournalError, ResourceJournalPin};
mod shared_peer;
#[cfg(test)]
pub(super) mod test_hooks;
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Purpose {
    ResumeWebsite,
    ResumeOwner,
    ResourceWebsite,
    PoolRegistrationWebsite,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum ClosePhase {
    Open,
    SocketsClosed,
    Finished,
    Unconfirmed,
}
#[must_use = "retain the whole channel on uncertain native finalization"]
pub struct WorkerActorChannel {
    connection: WorkerServiceConnection,
    hold: WorkerLaunchHold,
    peer: Option<Arc<shared_peer::SharedActorPeer>>,
    purpose: Purpose,
    greeted: bool,
    failed: bool,
    close: ClosePhase,
}
pub struct WorkerActorChannelFailure {
    connection: WorkerServiceConnection,
    hold: Option<WorkerLaunchHold>,
    cause: WorkerReportError,
}
impl WorkerActorChannelFailure {
    pub fn cause(&self) -> &WorkerReportError {
        &self.cause
    }
    /// No domain resource was admitted by a refused transport constructor.
    /// Consumed descriptor uncertainty still fences the original Record.
    pub fn close_for_worker(&mut self) -> Result<()> {
        match self.close_channel_component_for_worker()? {
            WorkerLaunchClose::Complete | WorkerLaunchClose::SocketClosedHandlerRetained => Ok(()),
            WorkerLaunchClose::SocketClosedLifecycleHeld => {
                Err(WorkerReportError::LifecycleRetained)
            }
        }
    }
    /// Preserve the actual SAME Record status even if this refused constructor
    /// issued no Hold. An independently held lifecycle cannot be released here.
    pub fn close_channel_component_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        self.connection.close_socket_for_worker()?;
        if let Some(hold) = self.hold.as_mut() {
            hold.release_for_worker()?;
        }
        let budget = super::budget::CleanupBudget::worker(&self.connection.service);
        self.connection
            .service
            .retire_launch(&self.connection.record, &budget)
    }
}
impl WorkerServiceConnection {
    pub fn retain_resume_website_channel(
        self,
        runtime: &WorkerRuntime,
    ) -> std::result::Result<WorkerActorChannel, Box<WorkerActorChannelFailure>> {
        WorkerActorChannel::retain(self, runtime, Purpose::ResumeWebsite)
    }
    pub fn retain_resume_owner_channel(
        self,
        runtime: &WorkerRuntime,
    ) -> std::result::Result<WorkerActorChannel, Box<WorkerActorChannelFailure>> {
        WorkerActorChannel::retain(self, runtime, Purpose::ResumeOwner)
    }
    pub fn retain_resource_website_channel(
        self,
        runtime: &WorkerRuntime,
    ) -> std::result::Result<WorkerActorChannel, Box<WorkerActorChannelFailure>> {
        WorkerActorChannel::retain(self, runtime, Purpose::ResourceWebsite)
    }
    /// Separate counted installation channel. It cannot acquire the RAM
    /// purpose by presenting another hello or an employee approval payload.
    pub fn retain_pool_registration_website_channel(
        self,
        runtime: &WorkerRuntime,
    ) -> std::result::Result<WorkerActorChannel, Box<WorkerActorChannelFailure>> {
        WorkerActorChannel::retain(self, runtime, Purpose::PoolRegistrationWebsite)
    }
}
impl WorkerActorChannel {
    fn retain(
        connection: WorkerServiceConnection,
        runtime: &WorkerRuntime,
        purpose: Purpose,
    ) -> std::result::Result<Self, Box<WorkerActorChannelFailure>> {
        let expected = match purpose {
            Purpose::ResumeWebsite => WorkerServicePurpose::ResumeRegistration,
            Purpose::ResumeOwner => WorkerServicePurpose::Control,
            Purpose::ResourceWebsite => WorkerServicePurpose::ResourceActor,
            Purpose::PoolRegistrationWebsite => WorkerServicePurpose::PoolRegistration,
        };
        if !connection.same_runtime(runtime) || connection.purpose() != expected {
            return Err(Box::new(WorkerActorChannelFailure {
                connection,
                hold: None,
                cause: WorkerReportError::Peer,
            }));
        }
        let hold = match connection.retain_lifecycle() {
            Ok(hold) => hold,
            Err(cause) => {
                return Err(Box::new(WorkerActorChannelFailure {
                    connection,
                    hold: None,
                    cause,
                }));
            }
        };
        Ok(Self {
            connection,
            hold,
            peer: None,
            purpose,
            greeted: false,
            failed: false,
            close: ClosePhase::Open,
        })
    }
    /// Original kernel credentials are DATA for the actual program verifier.
    pub fn peer(&self) -> &WorkerPeer {
        self.connection.peer()
    }
    /// Original authenticated first-frame DATA for the purpose's closed
    /// registration/command decoder. It is not supplied again by a caller.
    pub fn request_bytes(&self) -> &[u8] {
        self.connection.request_bytes()
    }
    pub fn assert_service(&self, expected: &Arc<WorkerReportService>) -> Result<()> {
        self.connection.assert_service(expected)
    }
    /// Qualifying the actual installed process remains the domain's task. The
    /// exact kernel socket-peer handle cannot be selected from wire PID data.
    pub fn pin_peer(&mut self) -> Result<()> {
        let result = self.pin();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn pin(&mut self) -> Result<()> {
        if self.failed || self.peer.is_some() || self.greeted {
            return Err(WorkerReportError::Unconfirmed);
        }
        let slot = self.connection.record.terminal_stream()?;
        let stream = slot.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        nix::sys::socket::setsockopt(stream, nix::sys::socket::sockopt::PassCred, &true)
            .map_err(|error| WorkerReportError::Io(error.into()))?;
        self.peer = Some(Arc::new(shared_peer::SharedActorPeer::new(
            super::peer_pin::acquire(stream)?,
        )));
        self.require_live()
    }
    fn require_live(&self) -> Result<()> {
        if self.failed || self.connection.service.stopping() {
            return Err(WorkerReportError::Stopping);
        }
        self.connection.record.require_terminal_hold()?;
        let peer = self.peer.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        peer.require_alive()
    }
    /// Adjacent cancellation observation for the actual action owner. This
    /// cannot replace that owner's fresh code, process, scope and target checks.
    pub fn require_connected(&self) -> Result<()> {
        self.require_live()?;
        if self.ended()? {
            Err(WorkerReportError::Peer)
        } else {
            Ok(())
        }
    }
    /// This positive observation permits registration replacement, not an
    /// action, process signal or implicit cleanup of any domain resources.
    pub fn peer_ended(&self) -> Result<bool> {
        if self.peer.is_none() || self.failed {
            return Err(WorkerReportError::Unconfirmed);
        }
        self.ended()
    }
    pub fn close_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        self.close_sockets()?;
        if self.close == ClosePhase::SocketsClosed {
            self.release_hold()?;
        }
        let handler = self.connection.record.handler_settled();
        if !self.connection.record.socket_closed_known() {
            self.close = ClosePhase::Unconfirmed;
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(if handler {
            WorkerLaunchClose::Complete
        } else {
            WorkerLaunchClose::SocketClosedHandlerRetained
        })
    }
    /// Close this exact socket and pinned peer while retaining the SAME counted
    /// lifecycle hold for a domain's uncertain native resources. No domain
    /// settlement, hold release or global shutdown acknowledgement is granted.
    pub fn disconnect_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        if self.close == ClosePhase::Finished {
            return Err(WorkerReportError::Unconfirmed);
        }
        self.close_sockets()?;
        Ok(WorkerLaunchClose::SocketClosedLifecycleHeld)
    }
    fn close_sockets(&mut self) -> Result<()> {
        self.failed = true;
        if self.close == ClosePhase::Unconfirmed {
            return Err(WorkerReportError::Unconfirmed);
        }
        if self.close == ClosePhase::Open {
            let budget = super::budget::CleanupBudget::worker(&self.connection.service);
            let socket = self.connection.record.finish_actor_channel(&budget);
            if matches!(socket, Err(WorkerReportError::ChannelClosePending)) && !self.opaque() {
                return Err(WorkerReportError::ChannelClosePending);
            }
            let socket =
                if matches!(socket, Err(WorkerReportError::ChannelClosePending)) && self.opaque() {
                    finalized(socket, Err(WorkerReportError::Unconfirmed))
                } else {
                    socket
                };
            let peer = self.peer.as_ref().map_or(Ok(()), |peer| peer.close());
            if matches!(peer, Err(WorkerReportError::ChannelClosePending)) && !self.opaque() {
                return Err(WorkerReportError::ChannelClosePending);
            }
            if peer.is_err() {
                self.connection.record.mark_opaque();
            } else {
                self.peer = None;
            }
            if let Err(error) = finalized(socket, peer) {
                self.close = ClosePhase::Unconfirmed;
                return Err(error);
            }
            self.close = ClosePhase::SocketsClosed;
        }
        Ok(())
    }
    fn release_hold(&mut self) -> Result<()> {
        if let Err(error) = self.hold.release_for_worker() {
            if self.opaque() {
                self.close = ClosePhase::Unconfirmed;
            }
            // Keep the original hold owner's error. Only the socket lock owner
            // can classify a wait-only refusal as ChannelClosePending.
            return Err(error);
        }
        self.close = ClosePhase::Finished;
        Ok(())
    }
    fn opaque(&self) -> bool {
        self.connection.record.opaque() || self.connection.service.opaque.load(Ordering::Acquire)
    }
}
impl Drop for WorkerActorChannel {
    fn drop(&mut self) {
        // Default destruction is not a checked close. The SAME Record's strong
        // logical hold remains counted; preserve its unfinalized peer handle.
        if let Some(peer) = self.peer.take() {
            std::mem::forget(peer);
        }
    }
}
