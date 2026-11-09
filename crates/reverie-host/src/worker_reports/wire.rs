use super::{WorkerReportError, WorkerReportService, error::Result};
#[cfg(test)]
mod tests;
use crate::command_telemetry::CommandTelemetry;
use reverie_core::worker_wire::{HEADER_BYTES, MAX_FRAME, WorkerFrameHeader};
use std::{
    io::Read,
    net::Shutdown,
    os::fd::{AsFd, AsRawFd},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};
pub(super) fn operate(
    service: &WorkerReportService,
    stream: &mut UnixStream,
    collector: &CommandTelemetry,
) -> Result<()> {
    authenticate(service, stream)?;
    // No frame or collector observation precedes actual kernel peer UID.
    collector.assert_engine(&service.engine)?;
    let (header, payload) = receive(service, stream)?;
    if header.kind() != b'T' {
        return Err(WorkerReportError::Refused);
    }
    report(service, stream, collector, &payload)
}
pub(super) fn report(
    service: &WorkerReportService,
    stream: &mut UnixStream,
    collector: &CommandTelemetry,
    payload: &[u8],
) -> Result<()> {
    // Preserve source common256KiB receive THEN purpose4096-byte refusal.
    let request = reverie_contracts::command_telemetry::decode_report_request(payload)
        .map_err(|_| WorkerReportError::Refused)?;
    let result = collector.command_failure_report(&request)?;
    send(service, stream, b'J', &result)
}
pub(super) fn authenticate(
    service: &WorkerReportService,
    stream: &UnixStream,
) -> Result<super::WorkerPeer> {
    if service.stopping() {
        return Err(WorkerReportError::Stopping);
    }
    timeouts(service, stream)?;
    let credentials =
        nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
            .map_err(|e| WorkerReportError::Io(e.into()))?;
    if credentials.uid() != service.uid {
        return Err(WorkerReportError::Peer);
    }
    Ok(super::WorkerPeer {
        uid: credentials.uid(),
        gid: credentials.gid(),
        pid: credentials.pid(),
    })
}
pub(super) fn receive(
    service: &WorkerReportService,
    stream: &mut UnixStream,
) -> Result<(WorkerFrameHeader, Vec<u8>)> {
    let mut header = [0u8; HEADER_BYTES];
    read(service, stream, &mut header)?;
    let header = WorkerFrameHeader::decode(header);
    let size = usize::try_from(header.payload_length()).map_err(|_| WorkerReportError::Frame)?;
    if size > MAX_FRAME {
        return Err(WorkerReportError::Frame);
    }
    let mut payload = vec![0; size];
    read(service, stream, &mut payload)?;
    Ok((header, payload))
}
fn timeouts(service: &WorkerReportService, stream: &UnixStream) -> Result<()> {
    let timeout = service
        .engine
        .stop_deadline()
        .map_or(Duration::from_secs(10), |end| {
            end.saturating_duration_since(Instant::now())
                .min(Duration::from_secs(10))
        });
    if timeout.is_zero() {
        return Err(WorkerReportError::Stopping);
    }
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    Ok(())
}
fn read(service: &WorkerReportService, stream: &mut UnixStream, bytes: &mut [u8]) -> Result<()> {
    read_for(service, stream, bytes, Duration::from_secs(10))
}
fn read_for(
    service: &WorkerReportService,
    stream: &mut UnixStream,
    mut bytes: &mut [u8],
    timeout: Duration,
) -> Result<()> {
    let mut attempt = None;
    while !bytes.is_empty() {
        if service.stopping() {
            return Err(WorkerReportError::Stopping);
        }
        // One recv attempt retains its monotonic deadline across EINTR. A new
        // source recv budget begins only after actual positive byte progress.
        let end = *attempt.get_or_insert_with(|| Instant::now() + timeout);
        stream.set_read_timeout(Some(remaining(service, end)?))?;
        #[cfg(test)]
        tests::receive_attempt_started();
        match stream.read(bytes) {
            Ok(0) => return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into()),
            Ok(count) => {
                bytes = &mut bytes[count..];
                attempt = None;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                #[cfg(test)]
                tests::received_interrupt();
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub(super) fn send(
    service: &WorkerReportService,
    stream: &mut UnixStream,
    kind: u8,
    payload: &[u8],
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let deadline = service
        .engine
        .stop_deadline()
        .map_or(deadline, |stop| stop.min(deadline));
    send_until(service, stream, kind, payload, deadline)
}
fn send_until(
    service: &WorkerReportService,
    stream: &mut UnixStream,
    kind: u8,
    payload: &[u8],
    deadline: Instant,
) -> Result<()> {
    let header =
        WorkerFrameHeader::for_payload(kind, payload.len()).ok_or(WorkerReportError::Frame)?;
    write(service, stream, &header.encode(), deadline)?;
    write(service, stream, payload, deadline)
}
fn write(
    service: &WorkerReportService,
    stream: &mut UnixStream,
    mut bytes: &[u8],
    deadline: Instant,
) -> Result<()> {
    while !bytes.is_empty() {
        // Python sendall's timeout covers the ENTIRE header+payload attempt,
        // including partial progress. A later chunk never gets another 10s.
        let _remaining = remaining(service, deadline)?;
        // Nonblocking is per call: keep the inherited OFD flags unchanged.
        // A blocking send can consume arbitrarily many progress wakeups inside
        // one syscall, so SO_SNDTIMEO alone cannot enforce sendall's deadline.
        let flags =
            nix::sys::socket::MsgFlags::MSG_DONTWAIT | nix::sys::socket::MsgFlags::MSG_NOSIGNAL;
        match nix::sys::socket::send(stream.as_raw_fd(), bytes, flags) {
            Ok(0) => return Err(std::io::Error::from(std::io::ErrorKind::WriteZero).into()),
            Ok(count) => bytes = &bytes[count..],
            Err(nix::errno::Errno::EINTR) => {}
            Err(nix::errno::Errno::EAGAIN) => writable(service, stream, deadline)?,
            Err(error) => return Err(std::io::Error::from(error).into()),
        }
    }
    Ok(())
}
fn writable(service: &WorkerReportService, stream: &UnixStream, deadline: Instant) -> Result<()> {
    loop {
        let duration = remaining(service, deadline)?;
        let milliseconds = duration
            .as_millis()
            .saturating_add(u128::from(duration.subsec_nanos() % 1_000_000 != 0));
        let timeout = nix::poll::PollTimeout::try_from(milliseconds)
            .map_err(|_| WorkerReportError::Unconfirmed)?;
        let mut descriptor = [nix::poll::PollFd::new(
            stream.as_fd(),
            nix::poll::PollFlags::POLLOUT,
        )];
        match nix::poll::poll(&mut descriptor, timeout) {
            Ok(0) | Err(nix::errno::Errno::EINTR) => {}
            Ok(_) => return Ok(()),
            Err(error) => return Err(std::io::Error::from(error).into()),
        }
    }
}
fn remaining(service: &WorkerReportService, deadline: Instant) -> Result<Duration> {
    let end = service
        .engine
        .stop_deadline()
        .map_or(deadline, |stop| stop.min(deadline));
    let remaining = end.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(std::io::Error::from(std::io::ErrorKind::TimedOut).into());
    }
    Ok(remaining)
}
pub(super) fn shutdown(stream: &UnixStream) -> Result<()> {
    match stream.shutdown(Shutdown::Both) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotConnected => Ok(()),
        Err(e) => Err(e.into()),
    }
}
