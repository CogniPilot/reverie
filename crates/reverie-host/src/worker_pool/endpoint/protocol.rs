//! Only the closed pool service protocol reaches this original peer. No raw
//! stream/descriptor, callback or arbitrary frame sender escapes its owner.
use super::*;
use crate::worker_pool::service::protocol::{MAX_FRAME, Received, Reply, Request};
use std::os::fd::AsFd;

impl ControllerPeer<'_> {
    pub(in crate::worker_pool) fn request_ready(&mut self) -> Result<bool> {
        let expected = self.endpoint.policy.bound_broker_data()?;
        let stream = self
            .native
            .stream
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_CONTROL_CLOSED"))?;
        let pidfd = self
            .native
            .pidfd
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_BROKER_PIDFD_UNKNOWN"))?;
        verify_peer(stream, pidfd, expected, &mut self.native.close_unknown)?;
        let mut ready = [nix::poll::PollFd::new(
            stream.as_fd(),
            nix::poll::PollFlags::POLLIN | nix::poll::PollFlags::POLLRDHUP,
        )];
        Ok(nix::poll::poll(&mut ready, nix::poll::PollTimeout::ZERO).map_err(io::Error::from)? > 0)
    }
    pub(in crate::worker_pool) fn receive_request(&mut self, end: Instant) -> Result<Received> {
        let prefix = self.read_exact(4, end)?;
        let count = u32::from_be_bytes(prefix.try_into().expect("fixed prefix")) as usize;
        need(
            (1..=MAX_FRAME).contains(&count),
            "WORKER_POOL_CONTROL_FRAME_BOUND",
        )?;
        Request::decode(&self.read_exact(count, end)?)
    }
    fn read_exact(&mut self, count: usize, end: Instant) -> Result<Vec<u8>> {
        let mut bytes = vec![0; count];
        let mut filled = 0;
        while filled < count {
            self.require_original_broker()?;
            need(Instant::now() < end, "WORKER_POOL_CONTROL_MESSAGE_DEADLINE")?;
            let expected = self.endpoint.policy.broker_birth()?;
            let expected = (expected.pid() as i32, expected.ids()[0], expected.ids()[1]);
            let stream = self
                .native
                .stream
                .as_ref()
                .ok_or(PoolError::Refused("WORKER_POOL_CONTROL_CLOSED"))?;
            match native::owned_process::receive_credentials(stream, &mut bytes[filled..], expected)
            {
                Ok(0) => return Err(PoolError::Refused("WORKER_POOL_CONTROL_PEER_ENDED")),
                Ok(count) => filled += count,
                Err(error) if error.close_failed => {
                    self.native.close_unknown = true;
                    return Err(PoolError::MetadataClose(Box::new(error.cause.into())));
                }
                Err(error) if error.cause.kind() == io::ErrorKind::Interrupted => (),
                Err(error) if error.cause.kind() == io::ErrorKind::WouldBlock => {
                    self.wait(nix::poll::PollFlags::POLLIN, end)?
                }
                Err(error) => return Err(error.cause.into()),
            }
        }
        self.require_original_broker()?;
        Ok(bytes)
    }
    pub(in crate::worker_pool) fn reply(&mut self, reply: &Reply<'_>, end: Instant) -> Result<()> {
        let raw = serde_json::to_vec(reply)
            .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROL_REPLY"))?;
        need(raw.len() <= MAX_FRAME, "WORKER_POOL_CONTROL_FRAME_BOUND")?;
        let mut bytes = (raw.len() as u32).to_be_bytes().to_vec();
        bytes.extend(raw);
        let mut sent = 0;
        while sent < bytes.len() {
            self.require_original_broker()?;
            need(Instant::now() < end, "WORKER_POOL_CONTROL_MESSAGE_DEADLINE")?;
            let stream = self
                .native
                .stream
                .as_ref()
                .ok_or(PoolError::Refused("WORKER_POOL_CONTROL_CLOSED"))?;
            match nix::sys::socket::send(
                stream.as_raw_fd(),
                &bytes[sent..],
                nix::sys::socket::MsgFlags::MSG_DONTWAIT | nix::sys::socket::MsgFlags::MSG_NOSIGNAL,
            ) {
                Ok(0) => return Err(PoolError::Refused("WORKER_POOL_CONTROL_PEER_ENDED")),
                Ok(count) => sent += count,
                Err(nix::errno::Errno::EINTR) => (),
                Err(nix::errno::Errno::EAGAIN) => self.wait(nix::poll::PollFlags::POLLOUT, end)?,
                Err(error) => return Err(io::Error::from(error).into()),
            }
        }
        self.require_original_broker()
    }
    fn wait(&self, event: nix::poll::PollFlags, end: Instant) -> Result<()> {
        let remaining = end.saturating_duration_since(Instant::now());
        need(!remaining.is_zero(), "WORKER_POOL_CONTROL_MESSAGE_DEADLINE")?;
        let stream = self
            .native
            .stream
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_CONTROL_CLOSED"))?;
        let mut ready = [nix::poll::PollFd::new(stream.as_fd(), event)];
        match nix::poll::poll(&mut ready, remaining.as_millis().clamp(1, 25) as u16) {
            Ok(_) | Err(nix::errno::Errno::EINTR) => Ok(()),
            Err(error) => Err(io::Error::from(error).into()),
        }
    }
}
