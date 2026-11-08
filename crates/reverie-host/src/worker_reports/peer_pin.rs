//! Shared fixed Linux socket-peer observations. No descriptor is duplicated;
//! the calling purpose retains its actual Record and sole owned pidfd.
use super::*;
use std::{
    os::fd::{AsFd, AsRawFd, OwnedFd},
    os::unix::net::UnixStream,
};

pub(super) fn acquire(stream: &UnixStream) -> Result<OwnedFd> {
    nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerPidfd).map_err(|error| {
        match error {
            nix::errno::Errno::ENOPROTOOPT | nix::errno::Errno::EINVAL => {
                WorkerReportError::ChannelCapability
            }
            _ => WorkerReportError::Io(error.into()),
        }
    })
}
pub(super) fn require_alive(peer: &OwnedFd) -> Result<()> {
    let mut fds = [nix::poll::PollFd::new(
        peer.as_fd(),
        nix::poll::PollFlags::POLLIN,
    )];
    let ready = nix::poll::poll(&mut fds, nix::poll::PollTimeout::ZERO)
        .map_err(|error| WorkerReportError::Io(error.into()))?;
    if ready == 0 {
        Ok(())
    } else {
        Err(WorkerReportError::Peer)
    }
}
pub(super) fn socket_ended(stream: &UnixStream) -> Result<bool> {
    let flags = nix::sys::socket::MsgFlags::MSG_DONTWAIT | nix::sys::socket::MsgFlags::MSG_PEEK;
    match nix::sys::socket::recv(stream.as_raw_fd(), &mut [0; 1], flags) {
        Ok(0) => Ok(true),
        Ok(_) | Err(nix::errno::Errno::EAGAIN) => Ok(false),
        Err(error) => Err(std::io::Error::from(error).into()),
    }
}

/// A forward-work guard must see peer FIN even while unread input remains.
/// Poll and peek are non-consuming and use only this SAME borrowed socket;
/// the legacy input/EOF helper above keeps its separate drain semantics.
pub(super) fn socket_disconnected(stream: &UnixStream) -> Result<bool> {
    let mut fds = [nix::poll::PollFd::new(
        stream.as_fd(),
        nix::poll::PollFlags::POLLIN | nix::poll::PollFlags::POLLRDHUP,
    )];
    let ready = nix::poll::poll(&mut fds, nix::poll::PollTimeout::ZERO)
        .map_err(|error| WorkerReportError::Io(error.into()))?;
    if ready != 0 {
        let flags = fds[0].revents().ok_or(WorkerReportError::Unconfirmed)?;
        if flags.intersects(nix::poll::PollFlags::POLLERR | nix::poll::PollFlags::POLLNVAL) {
            return Err(WorkerReportError::Unconfirmed);
        }
        if flags.intersects(nix::poll::PollFlags::POLLHUP | nix::poll::PollFlags::POLLRDHUP) {
            return Ok(true);
        }
    }
    socket_ended(stream)
}
