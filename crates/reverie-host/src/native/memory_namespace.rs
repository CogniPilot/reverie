//! Read the actual process credentials; no identity is supplied by a request.
pub(crate) fn memory_credentials() -> [u32; 4] {
    // SAFETY: these argument-free libc getters do not access caller pointers or
    // mutate process credentials. All four identities are compared on each use.
    unsafe {
        [
            libc::getuid(),
            libc::geteuid(),
            libc::getgid(),
            libc::getegid(),
        ]
    }
}

use std::{
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::PermissionsExt,
};
const LOCK_NAME: &std::ffi::CStr = c".memory-lifecycle-v1.lock";
pub(crate) fn memory_lock_file(parent: &File, create: bool) -> crate::observation::Result<File> {
    // Opening a substituted FIFO must not wait for a peer before the caller
    // checks that the held descriptor is an owned single-link regular file.
    let base = libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if create { libc::O_RDWR } else { libc::O_RDONLY };
    let flags = base
        | if create {
            libc::O_CREAT | libc::O_EXCL
        } else {
            0
        };
    // SAFETY: parent is a held directory; the fixed leaf is NUL terminated.
    // Successful openat transfers one new descriptor to File exactly once.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            LOCK_NAME.as_ptr(),
            flags,
            0o600 as libc::mode_t,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        if !create || error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
        // SAFETY: same fixed leaf and live parent. The existing file is never
        // chmodded, truncated, rewritten or deleted by this owner.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), LOCK_NAME.as_ptr(), base) };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        return Ok(unsafe { File::from_raw_fd(fd) });
    }
    let file = unsafe { File::from_raw_fd(fd) };
    if create && let Err(error) = file.set_permissions(std::fs::Permissions::from_mode(0o600)) {
        return crate::observation::finalized(Err(error.into()), super::close(file));
    }
    Ok(file)
}
pub(crate) fn memory_lock_entry(parent: &File) -> io::Result<File> {
    // SAFETY: fixed relative leaf, held directory and O_NOFOLLOW O_PATH. This
    // observes the name without following a foreign replacement symlink.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            LOCK_NAME.as_ptr(),
            libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_PATH,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
pub(crate) fn memory_lock(file: &File, exclusive: bool) -> io::Result<()> {
    let mode = if exclusive {
        libc::LOCK_EX
    } else {
        libc::LOCK_SH
    };
    // SAFETY: flock only uses the live owned descriptor. Nonblocking refusal
    // prevents startup/shutdown from waiting indefinitely behind a live recall.
    if unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
