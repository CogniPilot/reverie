//! Fixture-only bounded process-group and nonblocking-pipe custody.
use nix::{
    errno::Errno,
    fcntl::{FcntlArg, OFlag, fcntl},
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use std::{
    io::{self, Read},
    os::{fd::AsFd, unix::process::CommandExt},
    process::{Child, Command, ExitStatus, Output, Stdio},
    time::{Duration, Instant},
};

struct Owner {
    child: Child,
    group: Pid,
    settled: bool,
}
impl Owner {
    fn alive(&self) -> io::Result<bool> {
        match killpg(self.group, None) {
            Ok(()) => Ok(true),
            Err(Errno::ESRCH) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    fn kill(&self) {
        let _ = killpg(self.group, Signal::SIGKILL);
    }
    fn settle(&mut self, end: Instant) -> bool {
        self.kill();
        while Instant::now() < end {
            if self.child.try_wait().is_ok_and(|status| status.is_some())
                && self.alive().is_ok_and(|alive| !alive)
            {
                self.settled = true;
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if !self.settled {
            // Never block in Drop or claim unknown descendants were reaped.
            self.kill();
            let _ = self.child.try_wait();
        }
    }
}
struct Pipe<R> {
    reader: R,
    bytes: Vec<u8>,
    eof: bool,
}
impl<R: Read + AsFd> Pipe<R> {
    fn new(reader: R) -> io::Result<Self> {
        let flags = OFlag::from_bits_retain(fcntl(&reader, FcntlArg::F_GETFL)?);
        fcntl(&reader, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;
        Ok(Self {
            reader,
            bytes: Vec::new(),
            eof: false,
        })
    }
    fn drain(&mut self, limit: usize) -> io::Result<()> {
        let mut bytes = [0; 8192];
        // Bound each drain so a continuously writing child cannot starve the clock.
        for _ in 0..16 {
            match self.reader.read(&mut bytes) {
                Ok(0) => {
                    self.eof = true;
                    return Ok(());
                }
                Ok(size) => {
                    self.append(&bytes[..size], limit)?;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
    fn append(&mut self, bytes: &[u8], limit: usize) -> io::Result<()> {
        if self.bytes.len() + bytes.len() > limit {
            return Err(io::Error::other("owned hook fixture output limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
}

pub(super) fn bounded(
    command: &mut Command,
    timeout: Duration,
    limit: usize,
) -> io::Result<Output> {
    let end = Instant::now() + timeout;
    // Only this fresh child establishes the signallable group; no caller PGID.
    let child = command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let group = Pid::from_raw(i32::try_from(child.id()).map_err(io::Error::other)?);
    let mut owner = Owner {
        child,
        group,
        settled: false,
    };
    let result = capture(&mut owner, end, limit);
    if result.is_ok() {
        owner.settled = true;
        return result;
    }
    let confirmed =
        owner.settle((Instant::now() + Duration::from_secs(1)).min(end + Duration::from_secs(1)));
    Err(io::Error::other(format!(
        "{}; process-group settlement {}",
        result.unwrap_err(),
        if confirmed {
            "confirmed"
        } else {
            "unknown; retain private inputs"
        }
    )))
}
fn capture(owner: &mut Owner, end: Instant, limit: usize) -> io::Result<Output> {
    let mut stdout = Pipe::new(owner.child.stdout.take().unwrap())?;
    let mut stderr = Pipe::new(owner.child.stderr.take().unwrap())?;
    let mut status: Option<ExitStatus> = None;
    loop {
        stdout.drain(limit)?;
        stderr.drain(limit)?;
        if status.is_none() {
            status = owner.child.try_wait()?;
        }
        if let Some(status) = status.filter(|_| stdout.eof && stderr.eof)
            && !owner.alive()?
        {
            return Ok(Output {
                status,
                stdout: stdout.bytes,
                stderr: stderr.bytes,
            });
        }
        if Instant::now() >= end {
            return Err(io::Error::other("owned hook fixture command deadline"));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
#[path = "process/tests.rs"]
mod tests;
