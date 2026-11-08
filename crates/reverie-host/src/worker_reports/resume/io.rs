use super::*;
use std::os::fd::{AsFd, AsRawFd};

impl WorkerActorChannel {
    pub fn greet(&mut self, deadline: Instant) -> Result<()> {
        if self.greeted {
            return Err(WorkerReportError::Unconfirmed);
        }
        let bytes = match self.purpose {
            Purpose::ResumeWebsite => b"HOST_RESUME_READY\n".as_slice(),
            Purpose::ResumeOwner => b"HOST_RESUME_OWNER_READY\n".as_slice(),
            Purpose::ResourceWebsite => b"RESOURCE_READY\n".as_slice(),
            Purpose::PoolRegistrationWebsite => b"POOL_REGISTRATION_CHANNEL_V1\n".as_slice(),
        };
        // Original worker initial greetings inherit its ten-second sendall
        // timeout; later FramedChannel sends have a separate two-second cap.
        let result = self.write(
            bytes,
            deadline.min(Instant::now() + Duration::from_secs(10)),
        );
        self.failed |= result.is_err();
        if result.is_ok() {
            self.greeted = true;
        }
        result
    }
    /// Exactly one credential-checked chunk. The domain rechecks its actual
    /// installed program/process around EACH invocation, including partial
    /// length headers. Limits and deadlines are DATA, not authority callbacks.
    pub fn receive_chunk(&mut self, maximum: usize, deadline: Instant) -> Result<Vec<u8>> {
        if maximum == 0 || maximum > 8192 || !self.greeted {
            self.failed = true;
            return Err(WorkerReportError::Frame);
        }
        let result = self.read(maximum, deadline);
        self.failed |= result.is_err();
        result
    }
    pub fn send_frame(
        &mut self,
        frame: &reverie_contracts::human_protocol::HumanFrame,
        deadline: Instant,
    ) -> Result<()> {
        if !self.greeted {
            return Err(WorkerReportError::Unconfirmed);
        }
        let raw = frame.canonical().map_err(|_| WorkerReportError::Frame)?;
        let mut bytes = (raw.len() as u32).to_be_bytes().to_vec();
        bytes.extend(raw);
        let result = self.write(
            &bytes,
            deadline.min(Instant::now() + Duration::from_secs(2)),
        );
        self.failed |= result.is_err();
        result
    }
    fn read(&self, maximum: usize, requested: Instant) -> Result<Vec<u8>> {
        let end = requested.min(Instant::now() + Duration::from_secs(2));
        let slot = self.connection.record.terminal_stream()?;
        let stream = slot.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        let peer = self.connection.peer();
        let expected = (peer.pid(), peer.uid(), peer.gid());
        let mut bytes = vec![0; maximum];
        loop {
            self.remaining(end)?;
            match crate::native::owned_process::receive_credentials(stream, &mut bytes, expected) {
                Ok(0) => return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into()),
                Ok(count) => {
                    bytes.truncate(count);
                    self.remaining(end)?;
                    return Ok(bytes);
                }
                Err(error) if error.close_failed => {
                    self.connection.record.mark_opaque();
                    return Err(WorkerReportError::Unconfirmed);
                }
                Err(error) if error.cause.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) if error.cause.kind() == std::io::ErrorKind::WouldBlock => {
                    self.wait(stream, nix::poll::PollFlags::POLLIN, end)?;
                }
                Err(error) => return Err(error.cause.into()),
            }
        }
    }
    fn write(&self, mut bytes: &[u8], requested: Instant) -> Result<()> {
        let end = requested;
        let slot = self.connection.record.terminal_stream()?;
        let stream = slot.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        while !bytes.is_empty() {
            self.remaining(end)?;
            let flags =
                nix::sys::socket::MsgFlags::MSG_DONTWAIT | nix::sys::socket::MsgFlags::MSG_NOSIGNAL;
            match nix::sys::socket::send(stream.as_raw_fd(), bytes, flags) {
                Ok(0) => return Err(std::io::Error::from(std::io::ErrorKind::WriteZero).into()),
                Ok(count) => bytes = &bytes[count..],
                Err(nix::errno::Errno::EINTR) => {}
                Err(nix::errno::Errno::EAGAIN) => {
                    #[cfg(test)]
                    super::test_hooks::send_wait();
                    self.wait(stream, nix::poll::PollFlags::POLLOUT, end)?;
                }
                Err(error) => return Err(std::io::Error::from(error).into()),
            }
        }
        self.remaining(end).map(|_| ())
    }
    fn remaining(&self, requested: Instant) -> Result<Duration> {
        self.require_live()?;
        let end = self
            .connection
            .service
            .engine
            .stop_deadline()
            .map_or(requested, |stop| stop.min(requested));
        let duration = end.saturating_duration_since(Instant::now());
        if duration.is_zero() {
            Err(std::io::Error::from(std::io::ErrorKind::TimedOut).into())
        } else {
            Ok(duration)
        }
    }
    fn wait(
        &self,
        stream: &UnixStream,
        event: nix::poll::PollFlags,
        requested: Instant,
    ) -> Result<()> {
        let remaining = self.remaining(requested)?;
        let milliseconds = remaining.as_millis().clamp(1, 50) as u16;
        let mut fds = [nix::poll::PollFd::new(stream.as_fd(), event)];
        match nix::poll::poll(&mut fds, milliseconds) {
            Ok(_) | Err(nix::errno::Errno::EINTR) => Ok(()),
            Err(error) => Err(std::io::Error::from(error).into()),
        }
    }
    pub(super) fn ended(&self) -> Result<bool> {
        let peer = self.peer.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        if peer.ended()? {
            return Ok(true);
        }
        let slot = self.connection.record.terminal_stream()?;
        let stream = slot.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        super::super::peer_pin::socket_ended(stream)
    }
}
