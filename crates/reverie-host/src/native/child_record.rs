//! Fixed-purpose private child-record unlink. The caller owns and checks the
//! held launch directory and leaf identity; this does not authorize execution.
#![allow(unsafe_code)]
use std::{
    ffi::{CString, OsStr},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
};
pub(crate) fn unlink(directory: &File, name: &OsStr) -> io::Result<()> {
    let name = CString::new(name.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    // SAFETY: directory stays owned/live, name is terminated and flags0 only
    // removes one relative non-directory entry. Never retry an uncertain result.
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
pub(crate) fn create_private(directory: &File, name: &OsStr) -> io::Result<File> {
    let name = CString::new(name.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    // SAFETY: one fixed relative private file, exclusive/no-follow creation;
    // mode0600 is explicit and the standalone bootstrap's umask is0077.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
pub(crate) fn publish(directory: &File, temporary: &OsStr, target: &OsStr) -> io::Result<()> {
    let temporary = CString::new(temporary.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    let target = CString::new(target.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    // SAFETY: two terminated relative leaf names and one owned/live directory.
    // Never overwrite an existing receipt or retry an uncertain publication.
    if unsafe {
        libc::renameat2(
            directory.as_raw_fd(),
            temporary.as_ptr(),
            directory.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
