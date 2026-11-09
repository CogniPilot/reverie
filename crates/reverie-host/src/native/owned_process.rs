//! Narrow Linux pipe/pidfd syscalls. Child identity comes from a pidfd opened
//! by that child before exec, not from a racy parent PID lookup. No group signals.
#![allow(unsafe_code)]
mod ancillary;
#[cfg(test)]
mod tests;
pub(crate) use ancillary::receive_credentials;
use std::{
    io, mem,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd},
        unix::process::CommandExt,
    },
    process::Command,
};

pub(crate) fn executable(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: the terminated pathname remains live; X_OK with effective IDs
    // selects the installing service's executable including ACL permissions.
    unsafe { libc::faccessat(libc::AT_FDCWD, path.as_ptr(), libc::X_OK, libc::AT_EACCESS) == 0 }
}
pub(crate) fn close(fd: OwnedFd) -> io::Result<()> {
    // SAFETY: into_raw_fd transfers this descriptor exactly once; never retry
    // close after an error because its numeric slot might already be reused.
    let result = unsafe { libc::close(fd.into_raw_fd()) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
pub(crate) fn nonblocking(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: the descriptor stays owned/live for both fcntl calls.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
pub(crate) fn read(fd: &OwnedFd, buffer: &mut [u8]) -> io::Result<usize> {
    // SAFETY: buffer is writable for its length and fd stays owned/live.
    let result = unsafe { libc::read(fd.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result as usize)
    }
}
pub(crate) fn poll(fds: &[&OwnedFd], milliseconds: i32) -> io::Result<()> {
    let mut polls = fds
        .iter()
        .map(|fd| libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        })
        .collect::<Vec<_>>();
    // SAFETY: polls is live mutable storage for nfds initialized pollfd records.
    let result = unsafe {
        libc::poll(
            polls.as_mut_ptr(),
            polls.len() as libc::nfds_t,
            milliseconds,
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
pub(crate) fn kill(pidfd: &OwnedFd) -> io::Result<()> {
    // SAFETY: pidfd is the pre-exec child's exact process handle; the null
    // siginfo and zero flags request one SIGKILL, never a process-group signal.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0u32,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessStatus {
    Exited(u8),
    Signaled(i32),
}
impl ProcessStatus {
    pub(crate) fn shell_code(self) -> u8 {
        match self {
            Self::Exited(code) => code,
            Self::Signaled(signal) => 128i32.wrapping_add(signal) as u8,
        }
    }
    pub(crate) fn successful(self) -> bool {
        self == Self::Exited(0)
    }
}
pub(crate) fn reap_status(pidfd: &OwnedFd) -> io::Result<Option<ProcessStatus>> {
    // SAFETY: zero is a valid siginfo_t initialization; waitid writes into live
    // output storage and targets only the owned pidfd's child, with WNOHANG.
    let mut info: libc::siginfo_t = unsafe { mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PIDFD,
            pidfd.as_raw_fd() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful waitid initializes these documented siginfo fields;
    // zero si_pid means no child exit is ready and no status is consumed.
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    let status = unsafe { info.si_status() };
    match info.si_code {
        libc::CLD_EXITED => Ok(Some(ProcessStatus::Exited(
            u8::try_from(status).map_err(|_| io::ErrorKind::InvalidData)?,
        ))),
        libc::CLD_KILLED | libc::CLD_DUMPED if (1..=127).contains(&status) => {
            Ok(Some(ProcessStatus::Signaled(status)))
        }
        _ => Err(io::ErrorKind::InvalidData.into()),
    }
}

pub(crate) struct Handshake {
    receiver: Option<OwnedFd>,
    sender: Option<OwnedFd>,
}
pub(crate) struct ReceiveError {
    pub(crate) close_failed: bool,
}
pub(crate) struct PreparationError {
    pub(crate) close_failed: bool,
}
impl PreparationError {
    fn after_close(mut self, result: io::Result<()>) -> Self {
        self.close_failed |= result.is_err();
        self
    }
}
pub(super) fn reserve_descriptor(
    fd: OwnedFd,
    minimum: RawFd,
    mut finalizer: impl FnMut(OwnedFd) -> io::Result<()>,
) -> std::result::Result<OwnedFd, PreparationError> {
    if fd.as_raw_fd() >= minimum {
        return Ok(fd);
    }
    // SAFETY: duplicate this live descriptor above the standard streams so
    // Command's child stdio setup cannot overwrite the pre-exec channel.
    let duplicate = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, minimum) };
    if duplicate < 0 {
        return Err(PreparationError {
            close_failed: false,
        }
        .after_close(finalizer(fd)));
    }
    // SAFETY: successful fcntl returned a newly owned descriptor.
    let duplicate = unsafe { OwnedFd::from_raw_fd(duplicate) };
    if finalizer(fd).is_err() {
        return Err(PreparationError { close_failed: true }.after_close(finalizer(duplicate)));
    }
    Ok(duplicate)
}
/// One fixed registration input, reserved above stdio before Command installs
/// null stdin. Process retains the parent owner through spawn and closes once.
pub(crate) struct RegistrationInput(OwnedFd);
impl RegistrationInput {
    pub(crate) fn prepare(fd: OwnedFd) -> std::result::Result<Self, PreparationError> {
        reserve_descriptor(fd, 3, close).map(Self)
    }
    pub(crate) fn configure(&self, command: &mut Command) {
        let fd = self.0.as_raw_fd();
        // SAFETY: this type's private constructor reserves fd>=3. Process
        // retains its parent owner until spawn returns. dup2/close are async-
        // signal-safe and neither allocate nor lock. Close the child's original
        // descriptor exactly once, checking failure before exec. Its fd0 copy
        // survives successful exec; failed pre_exec exits/reaps the child.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(fd, libc::STDIN_FILENO) < 0 || libc::close(fd) != 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    pub(crate) fn finish(self) -> io::Result<()> {
        close(self.0)
    }
}
impl Handshake {
    pub(crate) fn new() -> std::result::Result<Self, PreparationError> {
        let mut pair = [-1; 2];
        // SAFETY: socketpair writes exactly two descriptors to live storage.
        // Linux atomically applies CLOEXEC/NONBLOCK, avoiding partial setup.
        let result = unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_DGRAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                0,
                pair.as_mut_ptr(),
            )
        };
        if result != 0 {
            return Err(PreparationError {
                close_failed: false,
            });
        }
        // SAFETY: successful socketpair transferred two newly owned fds.
        let receiver = unsafe { OwnedFd::from_raw_fd(pair[0]) };
        let sender = unsafe { OwnedFd::from_raw_fd(pair[1]) };
        let receiver = match reserve_descriptor(receiver, 3, close) {
            Ok(receiver) => receiver,
            Err(error) => return Err(error.after_close(close(sender))),
        };
        let sender = match reserve_descriptor(sender, 3, close) {
            Ok(sender) => sender,
            Err(error) => return Err(error.after_close(close(receiver))),
        };
        Ok(Self {
            receiver: Some(receiver),
            sender: Some(sender),
        })
    }
    pub(crate) fn configure(&self, command: &mut Command) {
        let fd = self
            .sender
            .as_ref()
            .expect("live private sender")
            .as_raw_fd();
        // SAFETY: the closure captures only a descriptor. It performs only
        // getpid/syscall/sendmsg/close and raw errno construction after fork;
        // no allocator, mutex, environment lookup or parent Rust callback runs.
        // CLOEXEC private socket endpoints cannot be accessed by the engine.
        unsafe {
            command.pre_exec(move || send_identity(fd));
        }
    }
    /// Closed interactive viewer purpose: the same child becomes a fresh
    /// session/group leader BEFORE transferring its exact pidfd to its owner.
    pub(super) fn configure_viewer(&self, command: &mut Command) {
        // SAFETY: setsid is async-signal-safe, uses no captured parent state,
        // and runs before the existing fixed identity handoff and exact exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        self.configure(command);
    }
    pub(crate) fn receive(&self) -> std::result::Result<OwnedFd, ReceiveError> {
        receive_identity(
            self.receiver
                .as_ref()
                .expect("live private receiver")
                .as_raw_fd(),
        )
    }
    pub(crate) fn finish(&mut self) -> io::Result<()> {
        let mut failed = false;
        for fd in [&mut self.receiver, &mut self.sender] {
            if let Some(fd) = fd.take() {
                failed |= close(fd).is_err();
            }
        }
        if failed {
            Err(io::ErrorKind::Other.into())
        } else {
            Ok(())
        }
    }
}
fn send_identity(socket: RawFd) -> io::Result<()> {
    // SAFETY: open a pidfd for SELF, before exec and before the parent can reap
    // this child. Kernel descriptor passing preserves identity across PID reuse.
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0u32) };
    if pidfd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut byte = [71u8];
    let mut iov = libc::iovec {
        iov_base: byte.as_mut_ptr().cast(),
        iov_len: 1,
    };
    let mut control = [0usize; 8];
    // SAFETY: initialized msghdr/iovec/control storage lives through sendmsg.
    // The usize control buffer is sufficiently large and aligned for one cmsg.
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    // libc exposes these ABI lengths as u32 on musl and usize on glibc. The
    // fixed one-fd/control-array lengths fit both without changing the protocol.
    message.msg_controllen = unsafe { libc::CMSG_SPACE(mem::size_of::<RawFd>() as u32) } as _;
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(mem::size_of::<RawFd>() as u32) as _;
        std::ptr::write_unaligned(libc::CMSG_DATA(header).cast::<RawFd>(), pidfd as RawFd);
    }
    // SAFETY: all message pointers above refer to initialized stack storage;
    // DONTWAIT and NOSIGNAL prevent a blocked handoff or SIGPIPE in pre_exec.
    let sent = unsafe { libc::sendmsg(socket, &message, libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL) };
    let error = if sent == 1 {
        None
    } else {
        Some(io::Error::last_os_error())
    };
    // SAFETY: this is the locally opened pidfd; the queued descriptor is a
    // distinct kernel reference. Close once even if sendmsg failed.
    let closed = unsafe { libc::close(pidfd as RawFd) };
    if let Some(error) = error {
        Err(error)
    } else if closed != 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn receive_identity(socket: RawFd) -> std::result::Result<OwnedFd, ReceiveError> {
    let mut byte = [0u8; 1];
    let packet = ancillary::receive(socket, &mut byte).map_err(|_| ReceiveError {
        close_failed: false,
    })?;
    let valid = packet.received == 1
        && byte == [71]
        && packet.flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) == 0
        && packet.valid
        && packet.headers == 1
        && packet.credentials.is_none()
        && packet.descriptors.len() == 1;
    let mut descriptors = packet.descriptors;
    if valid {
        return Ok(descriptors.pop().expect("one received descriptor"));
    }
    let mut close_failed = false;
    for descriptor in descriptors {
        close_failed |= close(descriptor).is_err();
    }
    Err(ReceiveError { close_failed })
}
