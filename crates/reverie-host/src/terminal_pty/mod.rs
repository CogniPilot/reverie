//! An owned Linux PTY resource. Its descriptors provide no installing-broker,
//! session, container, process-start or admission permission.
mod native;
#[cfg(test)]
mod test_hooks;
use nix::{
    fcntl::OFlag,
    pty::{self, PtyMaster},
    sys::termios::{
        self, ControlFlags, InputFlags, LocalFlags, OutputFlags, SetArg, SpecialCharacterIndices,
    },
};
use reverie_core::worker_launch::TerminalSize;
use std::{
    fmt,
    fs::File,
    io::{self, Read, Write},
    os::fd::{AsFd, AsRawFd, BorrowedFd, RawFd},
};
const IO_BYTES: usize = 65_536;

#[derive(Debug)]
pub struct PtyError {
    primary: Option<io::Error>,
    master_close: Option<io::Error>,
    slave_close: Option<io::Error>,
    prior_close: bool,
}
impl PtyError {
    pub fn close_uncertain(&self) -> bool {
        self.prior_close || self.master_close.is_some() || self.slave_close.is_some()
    }
    fn primary(error: io::Error) -> Self {
        Self {
            primary: Some(error),
            master_close: None,
            slave_close: None,
            prior_close: false,
        }
    }
}
impl fmt::Display for PtyError {
    fn fmt(&self, text: &mut fmt::Formatter<'_>) -> fmt::Result {
        text.write_str("Terminal resource failed")?;
        if let Some(error) = &self.primary {
            write!(text, ": {error}")?;
        }
        if let Some(error) = &self.master_close {
            write!(text, "; master close: {error}")?;
        }
        if let Some(error) = &self.slave_close {
            write!(text, "; slave close: {error}")?;
        }
        if self.prior_close {
            text.write_str("; earlier slave close unconfirmed")?;
        }
        Ok(())
    }
}
impl std::error::Error for PtyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.primary
            .as_ref()
            .map(|error| error as &dyn std::error::Error)
    }
}
/// Owns both new PTY descriptors until the actual child consumer closes the
/// slave. Dropping this type is best effort; only consuming close acknowledges
/// checked finalization. Neither action is a child/process cleanup receipt.
pub struct OwnedPty {
    master: PtyMaster,
    slave: Option<File>,
    slave_close_uncertain: bool,
}
impl OwnedPty {
    pub fn open(size: TerminalSize) -> Result<Self, PtyError> {
        let flags = OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK;
        let master = pty::posix_openpt(flags).map_err(|error| PtyError::primary(error.into()))?;
        let mut owned = Self {
            master,
            slave: None,
            slave_close_uncertain: false,
        };
        if let Err(primary) = owned.prepare(size) {
            return Err(owned.finish(Some(primary)).expect_err("preparation failed"));
        }
        Ok(owned)
    }
    fn prepare(&mut self, size: TerminalSize) -> io::Result<()> {
        pty::grantpt(&self.master)?;
        pty::unlockpt(&self.master)?;
        self.slave = Some(native::peer(self.master.as_fd())?);
        let slave = self.slave.as_ref().expect("owned new peer");
        let mut mode = termios::tcgetattr(slave)?;
        python_raw(&mut mode);
        termios::tcsetattr(slave, SetArg::TCSAFLUSH, &mode)?;
        native::resize(slave.as_fd(), size)?;
        #[cfg(test)]
        test_hooks::after_prepared()?;
        Ok(())
    }
    pub fn slave_fd(&self) -> io::Result<BorrowedFd<'_>> {
        self.slave
            .as_ref()
            .map(AsFd::as_fd)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotConnected, "terminal slave is closed"))
    }
    pub fn resize(&self, size: TerminalSize) -> io::Result<()> {
        native::resize(self.master.as_fd(), size)
    }
    pub fn try_read(&self, bytes: &mut [u8]) -> io::Result<usize> {
        let size = bytes.len().min(IO_BYTES);
        (&self.master).read(&mut bytes[..size])
    }
    pub fn try_write(&self, bytes: &[u8]) -> io::Result<usize> {
        (&self.master).write(&bytes[..bytes.len().min(IO_BYTES)])
    }
    pub fn close_slave(&mut self) -> Result<(), PtyError> {
        if let Some(slave) = self.slave.take()
            && let Err(error) = close_slave_file(slave)
        {
            self.slave_close_uncertain = true;
            let mut failure = PtyError::primary(error);
            failure.prior_close = true;
            return Err(failure);
        }
        if self.slave_close_uncertain {
            return Err(PtyError {
                primary: None,
                master_close: None,
                slave_close: None,
                prior_close: true,
            });
        }
        Ok(())
    }
    pub fn close(self) -> Result<(), PtyError> {
        self.finish(None)
    }
    fn finish(self, primary: Option<io::Error>) -> Result<(), PtyError> {
        let master_close = close_master(self.master).err();
        let slave_close = self.slave.and_then(|slave| close_slave_file(slave).err());
        let failure = PtyError {
            primary,
            master_close,
            slave_close,
            prior_close: self.slave_close_uncertain,
        };
        if failure.primary.is_some() || failure.close_uncertain() {
            Err(failure)
        } else {
            Ok(())
        }
    }
}
impl AsFd for OwnedPty {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.master.as_fd()
    }
}
impl AsRawFd for OwnedPty {
    fn as_raw_fd(&self) -> RawFd {
        self.master.as_raw_fd()
    }
}
fn close_master(master: PtyMaster) -> io::Result<()> {
    nix::unistd::close(master)?;
    #[cfg(test)]
    test_hooks::after_master_closed()?;
    Ok(())
}
fn close_slave_file(slave: File) -> io::Result<()> {
    nix::unistd::close(slave)?;
    #[cfg(test)]
    test_hooks::after_slave_closed()?;
    Ok(())
}
fn python_raw(mode: &mut termios::Termios) {
    // Frozen Python3.13 tty.cfmakeraw rules. libc cfmakeraw does not clear all
    // of these POSIX flags; no controlling terminal or process signal is set.
    mode.input_flags.remove(
        InputFlags::IGNBRK
            | InputFlags::BRKINT
            | InputFlags::IGNPAR
            | InputFlags::PARMRK
            | InputFlags::INPCK
            | InputFlags::ISTRIP
            | InputFlags::INLCR
            | InputFlags::IGNCR
            | InputFlags::ICRNL
            | InputFlags::IXON
            | InputFlags::IXANY
            | InputFlags::IXOFF,
    );
    mode.output_flags.remove(OutputFlags::OPOST);
    mode.control_flags
        .remove(ControlFlags::PARENB | ControlFlags::CSIZE);
    mode.control_flags.insert(ControlFlags::CS8);
    mode.local_flags.remove(
        LocalFlags::ECHO
            | LocalFlags::ECHOE
            | LocalFlags::ECHOK
            | LocalFlags::ECHONL
            | LocalFlags::ICANON
            | LocalFlags::IEXTEN
            | LocalFlags::ISIG
            | LocalFlags::NOFLSH
            | LocalFlags::TOSTOP,
    );
    mode.control_chars[SpecialCharacterIndices::VMIN as usize] = 1;
    mode.control_chars[SpecialCharacterIndices::VTIME as usize] = 0;
}
#[cfg(test)]
mod tests;
