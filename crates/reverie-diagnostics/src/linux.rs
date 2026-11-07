//! Only fixed inherited stdout/stderr. No caller-selected fd/path.
#![allow(unsafe_code)]
use super::StandardStream;
use std::{
    fs::{File, OpenOptions},
    io, mem,
    os::{
        fd::{AsRawFd, IntoRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
};
impl StandardStream {
    fn fd(self) -> i32 {
        match self {
            Self::Output => 1,
            Self::Error => 2,
        }
    }
    fn path(self) -> &'static str {
        match self {
            Self::Output => "/proc/self/fd/1",
            Self::Error => "/proc/self/fd/2",
        }
    }
}
pub(super) fn emit(stream: StandardStream, message: &[u8]) -> io::Result<()> {
    if message.is_empty() {
        return Ok(());
    }
    let info = metadata(stream)?;
    match info.st_mode & libc::S_IFMT {
        libc::S_IFREG => write_once(stream.fd(), message, false),
        libc::S_IFSOCK => write_once(stream.fd(), message, true),
        libc::S_IFIFO => {
            require_ignored_sigpipe()?;
            reopened(stream, message, &info)
        }
        libc::S_IFCHR => reopened(stream, message, &info),
        _ => Err(io::ErrorKind::Unsupported.into()),
    }
}
fn metadata(stream: StandardStream) -> io::Result<libc::stat> {
    // SAFETY: the fixed fd1/fd2 is borrowed, never closed/replaced; stat output is live ABI
    // storage. Checking its existing access mode never changes shared flags.
    let mut info: libc::stat = unsafe { mem::zeroed() };
    if unsafe { libc::fstat(stream.fd(), &mut info) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let flags = unsafe { libc::fcntl(stream.fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_ACCMODE == libc::O_RDONLY || flags & libc::O_PATH != 0 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(info)
}
fn reopened(stream: StandardStream, message: &[u8], original: &libc::stat) -> io::Result<()> {
    // Reopening a FIFO/TTY creates an independent open-file description, so
    // nonblocking mode cannot leak into the inherited stderr or its peers.
    // O_NOCTTY prevents acquiring a controlling terminal in a session leader.
    let file = OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOCTTY)
        .open(stream.path())?;
    let result = (|| {
        let current = file.metadata()?;
        if current.dev() != original.st_dev
            || current.ino() != original.st_ino
            || current.mode() != original.st_mode
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        write_once(file.as_raw_fd(), message, false)
    })();
    let closed = close(file);
    result.and(closed)
}
fn write_once(fd: i32, message: &[u8], socket: bool) -> io::Result<()> {
    // SAFETY: caller borrows a live stderr or newly owned reopened descriptor;
    // the input slice remains valid throughout this one syscall. No retry on
    // partial writes/EINTR. Socket flags avoid backpressure and SIGPIPE.
    let written = unsafe {
        if socket {
            libc::send(
                fd,
                message.as_ptr().cast(),
                message.len(),
                libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            )
        } else {
            libc::write(fd, message.as_ptr().cast(), message.len())
        }
    };
    if written < 0 {
        Err(io::Error::last_os_error())
    } else if written as usize == message.len() {
        Ok(())
    } else {
        Err(io::ErrorKind::WriteZero.into())
    }
}
fn close(file: File) -> io::Result<()> {
    let fd = file.into_raw_fd();
    // SAFETY: sole ownership is consumed. Never retry close: the descriptor
    // number may have been released/reused even when close returns an error.
    if unsafe { libc::close(fd) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
fn require_ignored_sigpipe() -> io::Result<()> {
    // Rust executables normally ignore SIGPIPE. If a consumer changed that
    // disposition, omit a FIFO diagnostic instead of risking process death
    // when its reader closes. Do not mutate process-global signal handling.
    let mut action: libc::sigaction = unsafe { mem::zeroed() };
    if unsafe { libc::sigaction(libc::SIGPIPE, std::ptr::null(), &mut action) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if action.sa_sigaction == libc::SIG_IGN {
        Ok(())
    } else {
        Err(io::ErrorKind::Unsupported.into())
    }
}
