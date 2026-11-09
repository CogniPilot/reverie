//! Read-only process identity for the actual Created container's init.
//! No signal or caller-selected process-control operation is exposed.
use std::{fs::File, io, os::fd::FromRawFd};

pub(crate) fn perf_init_pidfd(pid: u32) -> io::Result<File> {
    if !(2..=i32::MAX as u32).contains(&pid) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    // SAFETY: pidfd_open takes a bounded positive PID and zero flags, with no
    // caller pointers. Success returns exactly one newly owned descriptor.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0u32) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful syscall returned this sole Linux int descriptor;
    // File adopts it once and the Creation owner uses existing checked close.
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}
