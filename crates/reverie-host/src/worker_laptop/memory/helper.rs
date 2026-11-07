//! Client of the existing fixed root helper, one absolute budget and no retry.
use super::*;
use crate::native;
use reverie_contracts::worker_memory::{self, HELPER_FRAME_MAX, HelperReply};
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    path::Path,
    time::Duration,
};

pub(super) fn request(
    path: &Path,
    session: &reverie_core::ids::ProfileSessionId,
    container: &reverie_core::ids::ContainerId,
    expected: &reverie_core::decimal::UnsignedInteger,
    deadline: Instant,
    attempted: &mut bool,
) -> Result<()> {
    let payload = worker_memory::helper_request(session, container);
    need(
        payload.len() <= HELPER_FRAME_MAX,
        "LAPTOP_MEMORY_HELPER_REQUEST",
    )?;
    let mut socket = connect(path, deadline)?;
    let result = exchange(&mut socket, &payload, deadline, attempted);
    let fd: OwnedFd = socket.into();
    let closed = native::close(File::from(fd)).map_err(LaptopError::Observation);
    let raw = finalized(result, closed)?;
    match worker_memory::helper_reply(&raw, expected) {
        HelperReply::Confirmed => Ok(()),
        HelperReply::Refused(code) => {
            // Only an exact typed no-write reply can establish no helper effect.
            *attempted = false;
            Err(LaptopError::MemoryHelperRefused(code))
        }
        HelperReply::EffectUnconfirmed => Err(LaptopError::Refused("LAPTOP_MEMORY_HELPER_REPLY")),
    }
}
fn connect(path: &Path, deadline: Instant) -> Result<UnixStream> {
    use nix::sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket};
    let address = UnixAddr::new(path)
        .map_err(|_| LaptopError::Refused("LAPTOP_MEMORY_HELPER_UNAVAILABLE"))?;
    need(Instant::now() < deadline, "LAPTOP_MEMORY_DEADLINE")?;
    let fd = socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_CLOEXEC | SockFlag::SOCK_NONBLOCK,
        None,
    )
    .map_err(|_| LaptopError::Refused("LAPTOP_MEMORY_HELPER_UNAVAILABLE"))?;
    if connect(fd.as_raw_fd(), &address).is_err() {
        let closed = native::close(File::from(fd)).map_err(LaptopError::Observation);
        return finalized(
            Err(LaptopError::Refused("LAPTOP_MEMORY_HELPER_UNAVAILABLE")),
            closed,
        );
    }
    Ok(UnixStream::from(fd))
}
fn exchange(
    socket: &mut UnixStream,
    payload: &[u8],
    deadline: Instant,
    attempted: &mut bool,
) -> Result<Vec<u8>> {
    let mut sent = 0;
    while sent < payload.len() {
        check(deadline)?;
        *attempted = true;
        match socket.write(&payload[sent..]) {
            Ok(0) => return Err(LaptopError::Refused("LAPTOP_MEMORY_HELPER_SEND")),
            Ok(n) => sent += n,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => pause(deadline)?,
            Err(error) => return Err(LaptopError::Io(error)),
        }
    }
    let mut raw = Vec::new();
    while raw.last() != Some(&b'\n') && raw.len() <= HELPER_FRAME_MAX {
        check(deadline)?;
        let mut chunk = [0; HELPER_FRAME_MAX + 1];
        let capacity = HELPER_FRAME_MAX + 1 - raw.len();
        match socket.read(&mut chunk[..capacity]) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => pause(deadline)?,
            Err(error) => return Err(LaptopError::Io(error)),
        }
    }
    check(deadline)?;
    Ok(raw)
}
fn pause(deadline: Instant) -> Result<()> {
    check(deadline)?;
    std::thread::sleep(
        Duration::from_millis(1).min(deadline.saturating_duration_since(Instant::now())),
    );
    Ok(())
}
