//! Signal-aware stdout without changing the parent's shared descriptor flags.
use super::{close, stopped};
use crate::{Error, Result};
use std::fs::File;
use std::os::fd::{AsRawFd, IntoRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub(crate) struct Output {
    file: Option<File>,
    socket: bool,
}
impl Output {
    pub(crate) fn open() -> Result<Self> {
        let before = std::fs::metadata("/proc/self/fd/1")?;
        let kind = before.mode() & libc::S_IFMT;
        let file = if matches!(kind, libc::S_IFIFO | libc::S_IFCHR) {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOCTTY)
                .open("/proc/self/fd/1")?;
            let after = file.metadata()?;
            if (before.dev(), before.ino(), before.mode())
                != (after.dev(), after.ino(), after.mode())
            {
                return Err(Error::new("Output descriptor changed"));
            }
            Some(file)
        } else {
            None
        };
        Ok(Self {
            file,
            socket: kind == libc::S_IFSOCK,
        })
    }
    fn fd(&self) -> i32 {
        self.file.as_ref().map_or(1, AsRawFd::as_raw_fd)
    }
    pub(crate) fn write(&self, mut bytes: &[u8]) -> Result<()> {
        while !bytes.is_empty() {
            if stopped().is_some() {
                return Err(Error::new("Worker client interrupted"));
            }
            if !self.writable()? {
                continue;
            }
            if stopped().is_some() {
                return Err(Error::new("Worker client interrupted"));
            }
            let count = self.write_chunk(&bytes[..bytes.len().min(65_536)])?;
            bytes = &bytes[count..];
        }
        Ok(())
    }
    fn writable(&self) -> Result<bool> {
        let mut descriptor = libc::pollfd {
            fd: self.fd(),
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: descriptor is live; poll has initialized output storage.
        let ready = unsafe { libc::poll(&mut descriptor, 1, 250) };
        if ready >= 0 {
            return Ok(ready > 0);
        }
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            return Ok(false);
        }
        Err(Error::new("OSError"))
    }
    fn write_chunk(&self, bytes: &[u8]) -> Result<usize> {
        // SAFETY: bytes remain readable for their exact length; output is live.
        let count = unsafe {
            if self.socket {
                libc::send(
                    self.fd(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
                )
            } else {
                libc::write(self.fd(), bytes.as_ptr().cast(), bytes.len())
            }
        };
        if count > 0 {
            return Ok(count as usize);
        }
        let error = std::io::Error::last_os_error();
        if count < 0
            && matches!(
                error.kind(),
                std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
            )
        {
            return Ok(0);
        }
        Err(Error::new("Output unavailable"))
    }
    pub(crate) fn finish<T>(self, result: Result<T>) -> Result<T> {
        if let Some(file) = self.file {
            close(file.into_raw_fd())?;
        }
        result
    }
}
