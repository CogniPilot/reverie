//! Linux-owned subprocess and bounded pipe handling for channel recall.
use nix::{
    errno::Errno,
    fcntl::{FcntlArg, OFlag, fcntl},
    sys::{
        signal::{SigSet, Signal, kill, killpg},
        signalfd::{SfdFlags, SignalFd},
        wait::{Id, WaitPidFlag, WaitStatus, waitid},
    },
    unistd::Pid,
};
use std::{
    fs::File,
    io::{self, ErrorKind, Read, Write},
    os::{fd::AsFd, unix::process::CommandExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const TICK: Duration = Duration::from_millis(5);
const MAX_RSS_KIB: u64 = 256 * 1024;

pub(crate) struct Signals(SignalFd);

impl Signals {
    pub(crate) fn install() -> io::Result<Self> {
        let mut mask = SigSet::empty();
        for signal in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGHUP] {
            mask.add(signal);
        }
        mask.thread_block()?;
        Ok(Self(SignalFd::with_flags(
            &mask,
            SfdFlags::SFD_NONBLOCK | SfdFlags::SFD_CLOEXEC,
        )?))
    }
    fn check(&self) -> io::Result<()> {
        if self.0.read_signal()?.is_some() {
            return Err(io::Error::from(ErrorKind::Interrupted));
        }
        Ok(())
    }
}

pub(crate) struct Limits<'a> {
    deadline: Instant,
    stdout: usize,
    signals: Option<&'a Signals>,
    cancelled: Option<&'a AtomicBool>,
    group: bool,
}

impl<'a> Limits<'a> {
    pub(crate) fn worker(deadline: Instant, stdout: usize, signals: &'a Signals) -> Self {
        Self {
            deadline,
            stdout,
            signals: Some(signals),
            cancelled: None,
            group: true,
        }
    }
    pub(crate) fn office(deadline: Instant, stdout: usize) -> Self {
        Self {
            deadline,
            stdout,
            signals: None,
            cancelled: None,
            group: false,
        }
    }
    pub(crate) fn scoped(deadline: Instant, stdout: usize) -> Self {
        Self {
            group: true,
            ..Self::office(deadline, stdout)
        }
    }
    pub(crate) fn cancellable(deadline: Instant, stdout: usize, cancelled: &'a AtomicBool) -> Self {
        Self {
            cancelled: Some(cancelled),
            ..Self::scoped(deadline, stdout)
        }
    }
    fn group(&self) -> bool {
        self.group
    }
    fn check(&self, pid: Pid) -> io::Result<()> {
        if self
            .cancelled
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            return Err(ErrorKind::Interrupted.into());
        }
        if Instant::now() >= self.deadline {
            return Err(io::Error::from(ErrorKind::TimedOut));
        }
        if let Some(signals) = self.signals {
            signals.check()?;
            enforce_rss(pid)?;
        }
        Ok(())
    }
}

fn enforce_rss(pid: Pid) -> io::Result<()> {
    let mut status = String::new();
    match File::open(format!("/proc/{pid}/status")) {
        Ok(file) => {
            file.take(8192).read_to_string(&mut status)?;
        }
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let rss = status.lines().find_map(|line| {
        line.strip_prefix("VmRSS:")?
            .split_ascii_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
    });
    if rss.is_some_and(|size| size > MAX_RSS_KIB) {
        return Err(io::Error::other("channel memory resident limit exceeded"));
    }
    Ok(())
}

struct OwnedChild {
    child: Child,
    pid: Pid,
    group: bool,
    finalized: bool,
}

impl OwnedChild {
    fn spawn(mut command: Command, group: bool) -> io::Result<Self> {
        if group {
            command.process_group(0);
        }
        let child = command.spawn()?;
        let pid = Pid::from_raw(i32::try_from(child.id()).expect("Linux PID fits pid_t"));
        Ok(Self {
            child,
            pid,
            group,
            finalized: false,
        })
    }
    fn exited(&self) -> io::Result<bool> {
        let flags = WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT;
        loop {
            match waitid(Id::Pid(self.pid), flags) {
                Ok(status) => return Ok(status != WaitStatus::StillAlive),
                Err(Errno::EINTR) => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }
    fn settle(&mut self) -> io::Result<bool> {
        if self.finalized {
            return Err(io::Error::other("recall subprocess already finalized"));
        }
        self.finalized = true;
        // Observe the child without reaping before signaling. While waitable,
        // the leader pins its numeric identity through the final group signal.
        self.exited()?;
        let killed = if self.group {
            killpg(self.pid, Signal::SIGKILL)
        } else {
            kill(self.pid, Signal::SIGKILL)
        };
        if let Err(error) = killed
            && error != Errno::ESRCH
        {
            return Err(error.into());
        }
        let until = Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status.success());
            }
            if Instant::now() >= until {
                return Err(io::Error::from(ErrorKind::TimedOut));
            }
            std::thread::sleep(TICK);
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.finalized {
            let _ = self.settle();
        }
    }
}

struct Pipes<'a> {
    input: Option<ChildStdin>,
    pending: &'a [u8],
    out: Option<ChildStdout>,
    err: Option<ChildStderr>,
    output: Vec<u8>,
    diagnostics: Vec<u8>,
}

impl<'a> Pipes<'a> {
    fn new(child: &mut Child, request: Option<&'a [u8]>) -> io::Result<Self> {
        let input = nonblocking(child.stdin.take())?;
        let out = nonblocking(child.stdout.take())?;
        let err = nonblocking(child.stderr.take())?;
        Ok(Self {
            input,
            pending: request.unwrap_or_default(),
            out,
            err,
            output: Vec::new(),
            diagnostics: Vec::new(),
        })
    }
    fn pump(&mut self, limit: usize) -> io::Result<bool> {
        let sent = write(&mut self.input, &mut self.pending)?;
        let out = read(&mut self.out, &mut self.output, limit)?;
        let err = read(&mut self.err, &mut self.diagnostics, 4096).map_err(|error| {
            if error.kind() == ErrorKind::FileTooLarge {
                io::Error::new(ErrorKind::InvalidData, error)
            } else {
                error
            }
        })?;
        Ok(sent || out || err)
    }
    fn complete(&self) -> bool {
        self.input.is_none() && self.out.is_none() && self.err.is_none()
    }
}

fn nonblocking<T: AsFd>(fd: Option<T>) -> io::Result<Option<T>> {
    if let Some(fd) = &fd {
        let flags = OFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFL)?);
        fcntl(fd, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;
    }
    Ok(fd)
}

fn read<R: Read>(pipe: &mut Option<R>, output: &mut Vec<u8>, limit: usize) -> io::Result<bool> {
    let Some(reader) = pipe else { return Ok(false) };
    let mut bytes = [0; 16 * 1024];
    match reader.read(&mut bytes) {
        Ok(0) => *pipe = None,
        Ok(n) if output.len() + n <= limit => output.extend_from_slice(&bytes[..n]),
        Ok(_) => {
            return Err(io::Error::new(
                ErrorKind::FileTooLarge,
                "channel memory subprocess output exceeded its bound",
            ));
        }
        Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {
            return Ok(false);
        }
        Err(error) => return Err(error),
    }
    Ok(true)
}

fn write<W: Write>(pipe: &mut Option<W>, input: &mut &[u8]) -> io::Result<bool> {
    let Some(writer) = pipe else { return Ok(false) };
    match writer.write(input) {
        Ok(n) => *input = &input[n..],
        Err(error) if error.kind() == ErrorKind::BrokenPipe => *input = &[],
        Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {
            return Ok(false);
        }
        Err(error) => return Err(error),
    }
    if input.is_empty() {
        *pipe = None;
    }
    Ok(true)
}

pub(crate) fn run(
    command: Command,
    request: Option<&[u8]>,
    limits: Limits<'_>,
) -> io::Result<Vec<u8>> {
    let output = completed(command, request, limits)?;
    if !output.success {
        return Err(io::Error::other("channel memory subprocess refused"));
    }
    Ok(output.stdout)
}

pub(crate) struct Completed {
    pub(crate) success: bool,
    pub(crate) stdout: Vec<u8>,
}

pub(crate) fn completed(
    command: Command,
    request: Option<&[u8]>,
    limits: Limits<'_>,
) -> io::Result<Completed> {
    supervised(command, request, limits)?
}

/// Separate an unsuccessful capture from failure to establish or settle child ownership.
pub(crate) fn supervised(
    mut command: Command,
    request: Option<&[u8]>,
    limits: Limits<'_>,
) -> io::Result<io::Result<Completed>> {
    if limits
        .cancelled
        .is_some_and(|flag| flag.load(Ordering::Acquire))
    {
        return Ok(Err(ErrorKind::Interrupted.into()));
    }
    if Instant::now() >= limits.deadline {
        return Ok(Err(ErrorKind::TimedOut.into()));
    }
    command
        .stdin(if request.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = OwnedChild::spawn(command, limits.group())?;
    let output = collect(&mut child, request, &limits);
    let success = child.settle()?;
    Ok(output.map(|stdout| Completed { success, stdout }))
}

fn collect(
    child: &mut OwnedChild,
    request: Option<&[u8]>,
    limits: &Limits<'_>,
) -> io::Result<Vec<u8>> {
    let mut pipes = Pipes::new(&mut child.child, request)?;
    loop {
        limits.check(child.pid)?;
        let progress = pipes.pump(limits.stdout)?;
        if pipes.complete() && child.exited()? {
            break;
        }
        if !progress {
            std::thread::sleep(TICK);
        }
    }
    Ok(pipes.output)
}

pub(crate) fn quiet_group(
    mut command: Command,
    deadline: Instant,
    signals: &Signals,
) -> io::Result<bool> {
    signals.check()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = OwnedChild::spawn(command, true)?;
    loop {
        signals.check()?;
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        if child.exited()? {
            return child.settle();
        }
        std::thread::sleep(TICK);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn synthetic_worker() {
        match env::var("REVERIE_CHANNEL_CAPTURE_FIXTURE").as_deref() {
            Ok("resident") => {
                let allocation = vec![9_u8; 268 * 1024 * 1024];
                std::hint::black_box(&allocation);
                std::thread::sleep(Duration::from_secs(15));
            }
            Ok("deadline") => std::thread::sleep(Duration::from_secs(15)),
            _ => (),
        }
    }

    #[test]
    fn supervising_worker_enforces_rss_and_complete_deadline() {
        let signals = Signals::install().unwrap();
        for (kind, duration) in [
            ("resident", Duration::from_secs(5)),
            ("deadline", Duration::from_millis(120)),
        ] {
            let mut command = Command::new(env::current_exe().unwrap());
            command
                .args(["--exact", "capture::tests::synthetic_worker"])
                .env("REVERIE_CHANNEL_CAPTURE_FIXTURE", kind);
            let error = run(
                command,
                None,
                Limits::worker(Instant::now() + duration, 4096, &signals),
            )
            .unwrap_err();
            if kind == "resident" {
                assert!(error.to_string().contains("resident limit"), "{error}");
            } else {
                assert_eq!(error.kind(), ErrorKind::TimedOut);
            }
        }
    }
}
