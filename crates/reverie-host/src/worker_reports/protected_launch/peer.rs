//! The original L Record's kernel peer, not a wire PID or process grant. The
//! original logical hold remains separately owned throughout this metadata pin.
use super::*;
use std::os::fd::OwnedFd;

enum Close {
    Open,
    Known,
    Unconfirmed,
}
#[must_use = "retain original L hold and this exact native peer owner until checked close"]
pub struct ProtectedLaunchPeerPin {
    connection: Arc<WorkerLaunchConnection>,
    peer: Option<OwnedFd>,
    close: Close,
}
pub struct ProtectedLaunchPeerFailure {
    pin: ProtectedLaunchPeerPin,
    cause: WorkerReportError,
}
impl ProtectedLaunchPeerFailure {
    pub fn cause(&self) -> &WorkerReportError {
        &self.cause
    }
    pub fn close_metadata(&mut self) -> Result<()> {
        self.pin.close_metadata()
    }
}
impl HeldProtectedWorkerLaunch {
    /// One attempt on the actual held L owner. Wrong Runtime refuses before
    /// latching/opening; a started kernel pin is never reopened after failure.
    pub fn pin_peer(
        &mut self,
        runtime: &WorkerRuntime,
    ) -> std::result::Result<ProtectedLaunchPeerPin, Box<ProtectedLaunchPeerFailure>> {
        let mut pin = ProtectedLaunchPeerPin {
            connection: self.incoming.connection.clone(),
            peer: None,
            close: Close::Open,
        };
        let body = (|| {
            self.assert_current(runtime)?;
            if self.peer_pin_attempted {
                return Err(WorkerReportError::Unconfirmed);
            }
            self.peer_pin_attempted = true;
            let peer = {
                let slot = pin.source().record.terminal_stream()?;
                let stream = slot.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
                super::super::peer_pin::acquire(stream)?
            };
            pin.peer = Some(peer);
            pin.assert_current(runtime, &self.incoming.connection)
        })();
        match body {
            Ok(()) => Ok(pin),
            Err(cause) => Err(Box::new(ProtectedLaunchPeerFailure { pin, cause })),
        }
    }
}
impl ProtectedLaunchPeerPin {
    /// Exact original service identity only; no stream, descriptor or new
    /// lifecycle authority is exposed by this metadata check.
    pub fn assert_service(&self, expected: &Arc<WorkerReportService>) -> Result<()> {
        self.source().assert_service(expected)
    }
    #[cfg(test)]
    pub(in crate::worker_reports) fn test_descriptor(&self) -> Option<std::os::fd::RawFd> {
        use std::os::fd::AsRawFd;
        self.peer.as_ref().map(AsRawFd::as_raw_fd)
    }
    fn source(&self) -> &WorkerServiceConnection {
        let super::super::launch::LaunchOrigin::Protected(source) = &self.connection.origin else {
            unreachable!("only held L can construct this owner")
        };
        source
    }
    pub fn peer(&self) -> &WorkerPeer {
        self.source().peer()
    }
    pub fn assert_current(
        &self,
        runtime: &WorkerRuntime,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        if !std::ptr::eq(self.connection.as_ref(), connection) || !matches!(self.close, Close::Open)
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        self.connection.assert_protected_origin()?;
        self.connection.assert_open(runtime)?;
        self.source().record.require_terminal_hold()?;
        super::super::peer_pin::require_alive(
            self.peer.as_ref().ok_or(WorkerReportError::Unconfirmed)?,
        )?;
        let slot = self.source().record.terminal_stream()?;
        let stream = slot.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        let actual =
            nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
                .map_err(|error| WorkerReportError::Io(error.into()))?;
        let peer = self.peer();
        if actual.pid() != peer.pid()
            || actual.uid() != peer.uid()
            || actual.gid() != peer.gid()
            || super::super::peer_pin::socket_disconnected(stream)?
        {
            return Err(WorkerReportError::Peer);
        }
        Ok(())
    }
    /// Native metadata component only: never closes the original stream,
    /// releases its logical hold or acknowledges a domain/resource outcome.
    pub fn close_metadata(&mut self) -> Result<()> {
        match self.close {
            Close::Known => return Ok(()),
            Close::Unconfirmed => return Err(WorkerReportError::Unconfirmed),
            Close::Open => (),
        }
        let result = self.peer.take().map_or(Ok(()), |peer| {
            crate::native::close(std::fs::File::from(peer)).map_err(WorkerReportError::NativeClose)
        });
        self.close = if result.is_ok() {
            Close::Known
        } else {
            self.source().record.mark_opaque();
            Close::Unconfirmed
        };
        result
    }
    pub fn assert_finalized(&self) -> Result<()> {
        if matches!(self.close, Close::Known) && self.peer.is_none() {
            Ok(())
        } else {
            Err(WorkerReportError::Unconfirmed)
        }
    }
}
impl Drop for ProtectedLaunchPeerPin {
    fn drop(&mut self) {
        if let Some(peer) = self.peer.take() {
            // The sole native owner was not checked closed. Keep the original
            // counted Record unavailable even if its separate Hold is released.
            self.source().record.mark_opaque();
            std::mem::forget(peer);
        }
    }
}
