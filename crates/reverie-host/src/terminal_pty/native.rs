//! Linux PTY ioctl boundary. All descriptors are borrowed from the owning PTY;
//! no pathname, process ID or terminal request is accepted from the wire here.
#![allow(unsafe_code)]
use reverie_core::worker_launch::TerminalSize;
use std::{
    fs::File,
    io,
    os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
};

pub(super) fn peer(master: BorrowedFd<'_>) -> io::Result<File> {
    let flags = libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC;
    // SAFETY: master is a live borrowed PTY master; TIOCGPTPEER interprets its
    // third argument as these integer open flags, not a pointer. It creates a
    // new slave descriptor atomically with CLOEXEC and without acquiring a
    // controlling terminal. No existing descriptor ownership is transferred.
    let result = unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCGPTPEER, flags) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful TIOCGPTPEER returns one fresh owned descriptor. This
    // is its sole adoption; File retains it before any later fallible setup.
    let descriptor = unsafe { OwnedFd::from_raw_fd(result) };
    Ok(File::from(descriptor))
}
pub(super) fn resize(terminal: BorrowedFd<'_>, size: TerminalSize) -> io::Result<()> {
    let window = libc::winsize {
        ws_row: size.rows(),
        ws_col: size.cols(),
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: the descriptor is borrowed live for the call; window is initialized
    // ABI-sized storage and TIOCSWINSZ copies it synchronously without retaining
    // the pointer. TerminalSize already bounds rows/columns to 1..=1000.
    let result = unsafe { libc::ioctl(terminal.as_raw_fd(), libc::TIOCSWINSZ, &window) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(super) fn window(terminal: BorrowedFd<'_>) -> io::Result<libc::winsize> {
    let mut value = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: value is writable ABI-sized initialized winsize storage for this
    // synchronous copy; terminal remains borrowed live and no pointer escapes.
    let result = unsafe { libc::ioctl(terminal.as_raw_fd(), libc::TIOCGWINSZ, &mut value) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(value)
    }
}
