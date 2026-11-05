//! Linux syscall boundary. OwnedFd always transfers exactly one close obligation.
//! Unsafe is confined here; callers receive safe owned descriptors and Results.
#![allow(unsafe_code)]

use std::ffi::{CString, OsStr};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;

pub(crate) fn open_at(parent: RawFd, name: &OsStr, flags: i32) -> io::Result<OwnedFd> {
    #[cfg(test)]
    faults::opening(name)?;
    let name =
        CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    // SAFETY: name is NUL-terminated; openat returns a new owned descriptor.
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(test)]
    faults::opened(fd, name.to_string_lossy().into_owned());
    // SAFETY: fd was returned uniquely by successful openat.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
pub(crate) fn close(fd: OwnedFd) -> io::Result<()> {
    // Transfer ownership before close. EINTR and other close errors are never retried.
    let raw = fd.into_raw_fd();
    let result = if unsafe { libc::close(raw) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    };
    #[cfg(test)]
    faults::closed(raw)?;
    result
}
pub(crate) fn metadata(fd: &OwnedFd) -> io::Result<fs::Metadata> {
    #[cfg(test)]
    faults::metadata()?;
    // SAFETY: ManuallyDrop prevents this borrowed File view from closing fd.
    let file = std::mem::ManuallyDrop::new(unsafe { File::from_raw_fd(fd.as_raw_fd()) });
    file.metadata()
}
pub(crate) fn read_fd(fd: &OwnedFd, maximum: usize) -> io::Result<Vec<u8>> {
    // SAFETY: the borrowed view never outlives fd and ManuallyDrop never closes it.
    let mut file = std::mem::ManuallyDrop::new(unsafe { File::from_raw_fd(fd.as_raw_fd()) });
    let mut raw = Vec::new();
    (&mut *file)
        .take((maximum + 1) as u64)
        .read_to_end(&mut raw)?;
    if raw.len() > maximum {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(raw)
}
pub(crate) fn write_once(fd: &OwnedFd, raw: &[u8]) -> io::Result<usize> {
    #[cfg(test)]
    faults::writing()?;
    #[cfg(test)]
    let raw = faults::limited_write(raw);
    // SAFETY: fd is live, raw points to raw.len() readable bytes; exactly one call.
    let written = unsafe { libc::write(fd.as_raw_fd(), raw.as_ptr().cast(), raw.len()) };
    if written < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(written as usize)
    }
}
pub(crate) fn nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl operates on the borrowed live pipe descriptor; no ownership transfer.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
pub(crate) fn poll_readable(fds: [RawFd; 2], timeout: i32) {
    let mut polls = fds.map(|fd| libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    });
    // SAFETY: polls points to exactly two initialized pollfd entries for this call.
    let _ = unsafe { libc::poll(polls.as_mut_ptr(), 2, timeout) };
}
pub(crate) fn peer_uid(conn: &UnixStream) -> io::Result<u32> {
    let mut creds: libc::ucred = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: creds and size are valid writable objects with their declared sizes.
    let result = unsafe {
        libc::getsockopt(
            conn.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut creds as *mut libc::ucred).cast(),
            &mut size,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if size as usize != std::mem::size_of::<libc::ucred>() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(creds.uid)
}
pub(crate) fn duplicate_stdin() -> io::Result<OwnedFd> {
    // SAFETY: fcntl duplicates descriptor 0 into a fresh owned CLOEXEC descriptor.
    let fd = unsafe { libc::fcntl(0, libc::F_DUPFD_CLOEXEC, 3) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

#[cfg(test)]
pub(crate) mod faults {
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::ffi::OsStr;
    use std::io;
    use std::os::fd::RawFd;
    #[derive(Default)]
    pub(crate) struct Faults {
        pub(crate) fail_open: Option<&'static str>,
        pub(crate) fail_metadata: bool,
        pub(crate) fail_write: bool,
        pub(crate) partial_write: bool,
        pub(crate) write_calls: usize,
        pub(crate) fail_close: Option<&'static str>,
        pub(crate) close_after_write: bool,
        pub(crate) first_leaf_only: bool,
        pub(crate) written: bool,
        pub(crate) first_leaf: Option<RawFd>,
        pub(crate) opens: BTreeMap<RawFd, String>,
        pub(crate) closes: Vec<RawFd>,
    }
    thread_local! {pub(crate) static STATE:RefCell<Faults>=RefCell::new(Faults::default());}
    pub(crate) fn reset() {
        STATE.with(|s| *s.borrow_mut() = Faults::default());
    }
    pub(crate) fn opening(name: &OsStr) -> io::Result<()> {
        STATE.with(|state| {
            let state = state.borrow();
            if state
                .fail_open
                .is_some_and(|wanted| name == OsStr::new(wanted))
            {
                Err(io::ErrorKind::PermissionDenied.into())
            } else {
                Ok(())
            }
        })
    }
    pub(crate) fn opened(fd: RawFd, name: String) {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            if name == "laptop" && state.first_leaf.is_none() {
                state.first_leaf = Some(fd);
            }
            state.opens.insert(fd, name);
        });
    }
    pub(crate) fn metadata() -> io::Result<()> {
        STATE.with(|state| {
            if state.borrow().fail_metadata {
                Err(io::ErrorKind::Other.into())
            } else {
                Ok(())
            }
        })
    }
    pub(crate) fn writing() -> io::Result<()> {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.written = true;
            state.write_calls += 1;
            if state.fail_write {
                Err(io::ErrorKind::Interrupted.into())
            } else {
                Ok(())
            }
        })
    }
    pub(crate) fn limited_write(raw: &[u8]) -> &[u8] {
        STATE.with(|state| {
            if state.borrow().partial_write {
                &raw[..1]
            } else {
                raw
            }
        })
    }
    pub(crate) fn closed(fd: RawFd) -> io::Result<()> {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.closes.push(fd);
            if state
                .fail_close
                .is_some_and(|wanted| state.opens.get(&fd).is_some_and(|name| name == wanted))
                && (!state.close_after_write || state.written)
                && (!state.first_leaf_only || state.first_leaf == Some(fd))
            {
                state.fail_close = None;
                Err(io::ErrorKind::Other.into())
            } else {
                Ok(())
            }
        })
    }
}
