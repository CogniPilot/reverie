//! One recvmsg/CMSG owner shared by the original child identity handshake and
//! credential-only broker channels. Every installed right is either transferred
//! to the identity owner or consumed by one checked close, even on truncation.
use super::*;
use std::os::unix::net::UnixStream;

pub(crate) struct CredentialReadError {
    pub(crate) cause: io::Error,
    pub(crate) close_failed: bool,
}
pub(crate) fn receive_credentials(
    stream: &UnixStream,
    bytes: &mut [u8],
    expected: (i32, u32, u32),
) -> Result<usize, CredentialReadError> {
    if bytes.is_empty() || bytes.len() > 8192 {
        return Err(CredentialReadError {
            cause: io::ErrorKind::InvalidInput.into(),
            close_failed: false,
        });
    }
    let packet = receive(stream.as_raw_fd(), bytes).map_err(|cause| CredentialReadError {
        cause,
        close_failed: false,
    })?;
    let valid = packet.valid
        && packet.flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) == 0
        && packet.headers == 1
        && packet.credentials == Some(expected)
        && packet.descriptors.is_empty();
    let mut close_failed = false;
    for descriptor in packet.descriptors {
        close_failed |= close(descriptor).is_err();
    }
    if valid && !close_failed {
        Ok(packet.received)
    } else {
        let kind = if packet.received == 0 {
            io::ErrorKind::UnexpectedEof
        } else if packet.flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 {
            io::ErrorKind::InvalidData
        } else {
            io::ErrorKind::PermissionDenied
        };
        Err(CredentialReadError {
            cause: kind.into(),
            close_failed,
        })
    }
}
pub(super) struct Packet {
    pub(super) received: usize,
    pub(super) flags: i32,
    pub(super) valid: bool,
    pub(super) headers: usize,
    pub(super) credentials: Option<(i32, u32, u32)>,
    pub(super) descriptors: Vec<OwnedFd>,
}
pub(super) fn receive(socket: RawFd, bytes: &mut [u8]) -> io::Result<Packet> {
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let mut control = [0usize; 8];
    // SAFETY: message, iovec, byte slice and aligned ancillary storage remain
    // live and writable through recvmsg. The caller owns the socket throughout.
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = mem::size_of_val(&control) as _;
    let received = unsafe {
        libc::recvmsg(
            socket,
            &mut message,
            libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC,
        )
    };
    if received < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut packet = Packet {
        received: received as usize,
        flags: message.msg_flags,
        valid: true,
        headers: 0,
        credentials: None,
        descriptors: Vec::new(),
    };
    // SAFETY: successful recvmsg initializes only msg_controllen bytes within
    // the supplied storage. CMSG helpers bound traversal to that exact region.
    // Each SCM_RIGHTS integer denotes a fresh descriptor installed by Linux;
    // taking OwnedFd custody once is valid even when MSG_CTRUNC is also set.
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            packet.headers += 1;
            let size = ((*header).cmsg_len as usize).saturating_sub(libc::CMSG_LEN(0) as usize);
            let data = libc::CMSG_DATA(header);
            match ((*header).cmsg_level, (*header).cmsg_type) {
                (libc::SOL_SOCKET, libc::SCM_RIGHTS) => {
                    rights(&mut packet, data, size);
                }
                (libc::SOL_SOCKET, libc::SCM_CREDENTIALS)
                    if size == mem::size_of::<libc::ucred>() =>
                {
                    let value = std::ptr::read_unaligned(data.cast::<libc::ucred>());
                    packet.valid &= packet.credentials.is_none();
                    packet.credentials = Some((value.pid, value.uid, value.gid));
                }
                _ => packet.valid = false,
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    Ok(packet)
}
/// SAFETY: data points to the initialized body of one kernel-provided
/// SCM_RIGHTS record, for exactly size bytes inside the live control buffer.
unsafe fn rights(packet: &mut Packet, data: *mut u8, size: usize) {
    packet.valid &= size != 0 && size.is_multiple_of(mem::size_of::<RawFd>());
    for index in 0..size / mem::size_of::<RawFd>() {
        // SAFETY: each complete descriptor integer lies in that initialized
        // body. Unaligned reads do not impose extra alignment requirements.
        let fd = unsafe { std::ptr::read_unaligned(data.cast::<RawFd>().add(index)) };
        if fd >= 0 {
            // SAFETY: recvmsg installed each right as a fresh owned descriptor;
            // this traversal visits its integer once and immediately takes it.
            packet.descriptors.push(unsafe { OwnedFd::from_raw_fd(fd) });
        } else {
            packet.valid = false;
        }
    }
}
