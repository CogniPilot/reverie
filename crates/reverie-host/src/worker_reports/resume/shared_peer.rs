//! The original actor channel's sole native peer descriptor.
//! One actual pidfd. Only the original channel invokes checked close; journal
//! readers hold Weak references and cannot duplicate or extract this fd.
use super::*;
use std::{fs::File, os::fd::OwnedFd, sync::MutexGuard};

pub(super) struct SharedActorPeer {
    state: Mutex<State>,
}
enum State {
    Open(OwnedFd),
    Closed,
    Unconfirmed,
}
impl SharedActorPeer {
    pub(super) fn new(peer: OwnedFd) -> Self {
        Self {
            state: Mutex::new(State::Open(peer)),
        }
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>> {
        self.state.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => WorkerReportError::ChannelClosePending,
            TryLockError::Poisoned(_) => WorkerReportError::Unconfirmed,
        })
    }
    pub(super) fn require_alive(&self) -> Result<()> {
        let state = self.lock()?;
        match &*state {
            State::Open(peer) => super::super::peer_pin::require_alive(peer),
            State::Closed | State::Unconfirmed => Err(WorkerReportError::Unconfirmed),
        }
    }
    /// The original ended() poll semantics, distinct from require_alive():
    /// ordinary actor reconnection needs known peer EOF versus invalid poll.
    pub(super) fn ended(&self) -> Result<bool> {
        use std::os::fd::AsFd;
        let state = self.lock()?;
        let State::Open(peer) = &*state else {
            return Err(WorkerReportError::Unconfirmed);
        };
        let mut fds = [nix::poll::PollFd::new(
            peer.as_fd(),
            nix::poll::PollFlags::POLLIN,
        )];
        let ready = nix::poll::poll(&mut fds, nix::poll::PollTimeout::ZERO)
            .map_err(|error| WorkerReportError::Io(error.into()))?;
        if ready == 0 {
            return Ok(false);
        }
        let flags = fds[0].revents().ok_or(WorkerReportError::Unconfirmed)?;
        if flags.intersects(nix::poll::PollFlags::POLLERR | nix::poll::PollFlags::POLLNVAL) {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(flags.intersects(nix::poll::PollFlags::POLLIN | nix::poll::PollFlags::POLLHUP))
    }
    pub(super) fn close(&self) -> Result<()> {
        let mut state = self.lock()?;
        match std::mem::replace(&mut *state, State::Unconfirmed) {
            State::Open(peer) => {
                // This consumes the SAME descriptor once. Failure remains
                // Unconfirmed; neither this method nor Drop retries close.
                crate::native::close(File::from(peer)).map_err(WorkerReportError::NativeClose)?;
                *state = State::Closed;
                Ok(())
            }
            State::Closed => {
                *state = State::Closed;
                Ok(())
            }
            State::Unconfirmed => Err(WorkerReportError::Unconfirmed),
        }
    }
}
impl Drop for SharedActorPeer {
    fn drop(&mut self) {
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let State::Open(peer) = std::mem::replace(state, State::Unconfirmed) {
            // Default destruction grants no native-close observation.
            std::mem::forget(peer);
        }
    }
}
