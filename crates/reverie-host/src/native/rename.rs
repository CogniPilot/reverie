//! One Linux no-replace rename owner. Purpose wrappers retain directory/name
//! custody and select fixed destinations; this syscall never grants authority.
#![allow(unsafe_code)]
use std::{ffi::CStr, fs::File, io, os::fd::AsRawFd};
pub(super) fn noreplace(
    source: &File,
    from: &CStr,
    destination: &File,
    to: &CStr,
) -> io::Result<()> {
    for name in [from, to] {
        let bytes = name.to_bytes();
        if bytes.is_empty() || bytes.contains(&b'/') || matches!(bytes, b"." | b"..") {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    // SAFETY: both borrowed File owners and terminated relative leaf names
    // remain live throughout the identical Linux syscall used by the existing
    // child-receipt/profile owners. No pointers escape, no fd is transferred,
    // NOREPLACE is fixed, and an uncertain return is never retried here.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source.as_raw_fd(),
            from.as_ptr(),
            destination.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
