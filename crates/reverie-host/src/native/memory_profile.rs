//! One fixed derived-profile publication within its held installed directory.
#![allow(unsafe_code)]
use std::{
    ffi::{CString, OsStr},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};
fn leaf(name: &OsStr) -> io::Result<CString> {
    if Path::new(name).file_name() != Some(name) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    CString::new(name.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput.into())
}
pub(crate) fn create(parent: &File, name: &OsStr) -> io::Result<File> {
    let name = leaf(name)?;
    // SAFETY: held directory and terminated single leaf remain live. Creation
    // is exclusive and no-follow, with atomically close-on-exec ownership.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful exclusive open transferred one newly owned fd.
    Ok(unsafe { File::from_raw_fd(fd) })
}
pub(crate) fn entry(parent: &File, name: &OsStr) -> io::Result<File> {
    let _ = leaf(name)?;
    super::lease::open_at(parent.as_raw_fd(), name, libc::O_PATH)
}
pub(crate) fn remove(parent: &File, name: &OsStr) -> io::Result<()> {
    let name = leaf(name)?;
    // SAFETY: this borrowed parent remains held and the name cannot traverse;
    // the purpose wrapper verifies its pinned temporary before this one unlink.
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
pub(crate) fn publish(parent: &File, temporary: &OsStr) -> io::Result<()> {
    let temporary = leaf(temporary)?;
    super::rename::noreplace(parent, &temporary, parent, c"profile.md")
}
