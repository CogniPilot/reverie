//! Linux syscall adapter. Each owned descriptor is transferred or closed once.
#![allow(unsafe_code)]

use crate::{Error, Result};
use std::ffi::CString;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::Instant;
mod output;
pub(crate) use output::Output;

pub(crate) fn close(fd: i32) -> Result<()> {
    // SAFETY: callers transfer sole ownership. Never retry close after an error.
    let closed = unsafe { libc::close(fd) };
    #[cfg(test)]
    if FAIL_CLOSE.with(|failure| failure.replace(false)) {
        return Err(Error("OSError"));
    }
    if closed == 0 {
        Ok(())
    } else {
        Err(Error("OSError"))
    }
}
fn uid() -> u32 {
    // SAFETY: getuid has no preconditions.
    unsafe { libc::getuid() }
}
pub(crate) struct Endpoint {
    path: PathBuf,
    anchor: File,
    stamp: (u64, u64, u32, u32),
}
fn stamp(meta: &std::fs::Metadata) -> (u64, u64, u32, u32) {
    (meta.dev(), meta.ino(), meta.mode(), meta.uid())
}
impl Endpoint {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let anchor = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let meta = anchor.metadata()?;
        if meta.mode() & libc::S_IFMT != libc::S_IFSOCK
            || meta.mode() & 0o077 != 0
            || meta.uid() != uid()
        {
            return Err(Error("Worker socket is unavailable or not private"));
        }
        let result = Self {
            path: path.into(),
            anchor,
            stamp: stamp(&meta),
        };
        result.current()?;
        Ok(result)
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    fn current(&self) -> Result<()> {
        let meta = std::fs::symlink_metadata(&self.path)?;
        if stamp(&meta) != self.stamp {
            return Err(Error("Private worker broker endpoint changed"));
        }
        Ok(())
    }
    pub(crate) fn check(&self, stream: &UnixStream) -> Result<()> {
        // SAFETY: zeroed ucred is valid output storage, with its exact length.
        let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of_val(&peer) as libc::socklen_t;
        let status = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut peer as *mut libc::ucred).cast(),
                &mut size,
            )
        };
        if status != 0 || size as usize != std::mem::size_of_val(&peer) {
            return Err(Error("Private worker broker peer changed"));
        }
        self.accept_peer(peer.uid)
    }
    fn accept_peer(&self, peer_uid: u32) -> Result<()> {
        if peer_uid != uid() {
            return Err(Error("Private worker broker peer changed"));
        }
        self.current()
    }
    pub(crate) fn close(self) -> Result<()> {
        close(self.anchor.into_raw_fd())
    }
}
pub(crate) fn wait(fd: i32, events: i16, deadline: Option<Instant>) -> Result<()> {
    loop {
        if STOP.load(Ordering::Relaxed) != 0 {
            return Err(Error("Worker client interrupted"));
        }
        let timeout = match deadline {
            None => 250,
            Some(deadline) => {
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .ok_or(Error("Private worker deadline exceeded"))?;
                remaining
                    .as_millis()
                    .saturating_add(1)
                    .min(i32::MAX as u128) as i32
            }
        };
        let mut descriptor = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: the one initialized descriptor is live for this syscall.
        let ready = unsafe { libc::poll(&mut descriptor, 1, timeout) };
        if STOP.load(Ordering::Relaxed) != 0 {
            return Err(Error("Worker client interrupted"));
        }
        if ready > 0 {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err(Error("Worker descriptor unavailable"));
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(Error("Private worker deadline exceeded"));
            }
            return Ok(());
        }
        if ready == 0 && deadline.is_none() {
            continue;
        }
        if ready == 0 {
            return Err(Error("Private worker deadline exceeded"));
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(Error("OSError"));
        }
        if STOP.load(Ordering::Relaxed) != 0 {
            return Err(Error("Worker client interrupted"));
        }
    }
}
pub(crate) fn connect(path: &Path, deadline: Option<Instant>) -> Result<UnixStream> {
    let path =
        CString::new(path.as_os_str().as_bytes()).map_err(|_| Error("Invalid worker socket"))?;
    // SAFETY: initialized sockaddr_un output storage; bytes copied with length check.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    if path.as_bytes_with_nul().len() > address.sun_path.len() {
        return Err(Error("Invalid worker socket"));
    }
    for (destination, source) in address.sun_path.iter_mut().zip(path.as_bytes_with_nul()) {
        *destination = *source as libc::c_char;
    }
    // SAFETY: socket takes scalar flags and returns a fresh owned descriptor.
    let fd = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if fd < 0 {
        return Err(Error("OSError"));
    }
    // SAFETY: fd is a fresh Unix stream and ownership moves to this stream once.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    let outcome = connect_owned(&stream, &address, deadline);
    if let Err(error) = outcome {
        let _closed = close(stream.into_raw_fd());
        return Err(error);
    }
    Ok(stream)
}
fn connect_owned(
    stream: &UnixStream,
    address: &libc::sockaddr_un,
    deadline: Option<Instant>,
) -> Result<()> {
    // SAFETY: address is an initialized Unix address with valid exact size.
    let connected = unsafe {
        libc::connect(
            stream.as_raw_fd(),
            (address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(address) as libc::socklen_t,
        )
    };
    if connected != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error.into());
        }
        wait(stream.as_raw_fd(), libc::POLLOUT, deadline)?;
        if let Some(error) = stream.take_error()? {
            return Err(error.into());
        }
    }
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(Error("Private worker deadline exceeded"));
    }
    Ok(())
}

static RESIZED: AtomicBool = AtomicBool::new(false);
static STOP: AtomicI32 = AtomicI32::new(0);
extern "C" fn signal(signal: i32) {
    if signal == libc::SIGWINCH {
        RESIZED.store(true, Ordering::Relaxed);
    } else {
        STOP.store(signal, Ordering::Relaxed);
    }
}
pub(crate) fn resized() -> bool {
    RESIZED.swap(false, Ordering::Relaxed)
}
pub(crate) fn stopped() -> Option<u8> {
    let signal = STOP.load(Ordering::Relaxed);
    (signal != 0).then_some((128 + signal) as u8)
}
pub(crate) fn dimensions() -> (u16, u16) {
    // SAFETY: initialized winsize is writable output for a descriptor ioctl.
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut size) } == 0 {
        (size.ws_col, size.ws_row)
    } else {
        (120, 40)
    }
}
pub(crate) struct Terminal {
    original: Option<libc::termios>,
    handlers: Vec<(i32, libc::sigaction)>,
}
impl Terminal {
    pub(crate) fn enter() -> Result<Self> {
        RESIZED.store(false, Ordering::Relaxed);
        STOP.store(0, Ordering::Relaxed);
        let mut result = Self {
            original: None,
            handlers: Vec::new(),
        };
        for number in [libc::SIGWINCH, libc::SIGINT, libc::SIGTERM] {
            // SAFETY: initialized actions, handler uses lock-free atomics only.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = signal as *const () as usize;
            if unsafe { libc::sigaction(number, &action, &mut previous) } != 0 {
                return Err(Error("OSError"));
            }
            result.handlers.push((number, previous));
        }
        // SAFETY: isatty and terminal output storage refer to caller-owned stdin.
        if unsafe { libc::isatty(0) } != 0 {
            let mut previous: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(0, &mut previous) } != 0 {
                return Err(Error("OSError"));
            }
            result.original = Some(previous);
            let mut raw = previous;
            unsafe { libc::cfmakeraw(&mut raw) };
            if unsafe { libc::tcsetattr(0, libc::TCSANOW, &raw) } != 0 {
                return Err(Error("OSError"));
            }
        }
        Ok(result)
    }
    fn restore(&mut self) -> Result<()> {
        let mut failed = false;
        if let Some(previous) = self.original.take() {
            // SAFETY: previous was returned by tcgetattr for this stdin.
            failed = unsafe { libc::tcsetattr(0, libc::TCSADRAIN, &previous) } != 0;
        }
        for (number, action) in self.handlers.drain(..).rev() {
            // SAFETY: each saved action was returned for this signal number.
            failed |= unsafe { libc::sigaction(number, &action, std::ptr::null_mut()) } != 0;
        }
        if failed {
            Err(Error("Terminal restoration unconfirmed"))
        } else {
            Ok(())
        }
    }
    pub(crate) fn finish<T>(mut self, result: Result<T>) -> Result<T> {
        self.restore()?;
        result
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _restored = self.restore();
    }
}
pub(crate) fn poll_terminal(socket: i32) -> Result<(bool, bool)> {
    let mut descriptors = [
        libc::pollfd {
            fd: socket,
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    // SAFETY: both initialized poll descriptors live through the call.
    let count = unsafe { libc::poll(descriptors.as_mut_ptr(), 2, 250) };
    if count < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
        return Err(Error("OSError"));
    }
    if descriptors
        .iter()
        .any(|fd| fd.revents & libc::POLLNVAL != 0)
    {
        return Err(Error("Worker descriptor unavailable"));
    }
    Ok((descriptors[0].revents != 0, descriptors[1].revents != 0))
}

#[cfg(test)]
thread_local! { static FAIL_CLOSE:std::cell::Cell<bool>=const { std::cell::Cell::new(false) }; }
#[cfg(test)]
pub(crate) fn with_close_failure<T>(action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FAIL_CLOSE.with(|failure| failure.set(false));
        }
    }
    let _reset = Reset;
    FAIL_CLOSE.with(|failure| failure.set(true));
    action()
}
#[cfg(test)]
mod tests {
    use super::{Endpoint, uid, with_close_failure};
    use crate::test_support::Socket;
    #[test]
    fn foreign_peer_uid_and_endpoint_close_failure_are_refusals() {
        let socket = Socket::new();
        let endpoint = Endpoint::open(&socket.path).unwrap();
        assert!(endpoint.accept_peer(uid().wrapping_add(1)).is_err());
        assert!(endpoint.accept_peer(uid()).is_ok());
        assert!(with_close_failure(|| endpoint.close()).is_err());
    }
}
