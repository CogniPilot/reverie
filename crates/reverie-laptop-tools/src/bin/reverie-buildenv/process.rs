use super::{Build, EX_FEWER_FILES, EX_TEMPFAIL, MIB, admission::Limits, observe, tenths, vitest};
use nix::{
    errno::Errno,
    sys::{
        resource::{UsageWho, getrusage},
        signal::{Signal as UnixSignal, killpg},
        wait::{Id, WaitPidFlag, WaitStatus, waitid},
    },
    unistd::Pid,
};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    os::unix::process::{CommandExt, ExitStatusExt},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use tokio::signal::unix::{Signal, SignalKind, signal};

const TERMINATION_GRACE: Duration = Duration::from_secs(5);
const DRAIN_GRACE: Duration = Duration::from_secs(10);
const TAIL_BYTES: usize = 64 * 1024;

pub(super) struct Stops {
    term: Signal,
    interrupt: Signal,
    hangup: Signal,
    // Ensure the kernel keeps our child waitable even if the caller ignored SIGCHLD.
    _child_status: Signal,
}
impl Stops {
    pub(super) fn install() -> io::Result<Self> {
        Ok(Self {
            term: signal(SignalKind::terminate())?,
            interrupt: signal(SignalKind::interrupt())?,
            hangup: signal(SignalKind::hangup())?,
            _child_status: signal(SignalKind::child())?,
        })
    }

    pub(super) async fn next(&mut self) -> UnixSignal {
        tokio::select! {
            _ = self.term.recv() => UnixSignal::SIGTERM,
            _ = self.interrupt.recv() => UnixSignal::SIGINT,
            _ = self.hangup.recv() => UnixSignal::SIGHUP,
        }
    }

    async fn before_spawn(&mut self) -> io::Result<()> {
        tokio::select! {
            biased;
            _ = self.next() => Err(io::Error::new(io::ErrorKind::Interrupted, "build admission interrupted")),
            () = std::future::ready(()) => Ok(()),
        }
    }
}

struct Group {
    child: Child,
    pid: Pid,
    reaped: bool,
}
impl Group {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        let child = command.process_group(0).spawn()?;
        let id = i32::try_from(child.id()).map_err(io::Error::other)?;
        Ok(Self {
            child,
            pid: Pid::from_raw(id),
            reaped: false,
        })
    }

    fn exited(&self) -> io::Result<bool> {
        // Observe without reaping: the leader keeps its PID and process group
        // from being reused through the last group signal.
        let flags = WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT;
        loop {
            match waitid(Id::Pid(self.pid), flags) {
                Ok(status) => return Ok(status != WaitStatus::StillAlive),
                Err(Errno::EINTR) => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }

    fn send(&self, signal: UnixSignal) -> io::Result<()> {
        match killpg(self.pid, signal) {
            Ok(()) | Err(Errno::ESRCH) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn finish(&mut self) -> io::Result<ExitStatus> {
        self.send(UnixSignal::SIGKILL)?;
        let status = self.child.wait()?;
        self.reaped = true;
        Ok(status)
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        if !self.reaped && self.exited().is_ok() {
            let _ = self.send(UnixSignal::SIGKILL);
            let _ = self.child.wait();
        }
    }
}

#[derive(Default)]
struct Shutdown {
    deadline: Option<Instant>,
    forced: bool,
    memory: Option<observe::Usage>,
}
impl Shutdown {
    fn start(
        &mut self,
        group: &Group,
        signal: UnixSignal,
        memory: Option<observe::Usage>,
    ) -> io::Result<()> {
        group.send(signal)?;
        self.deadline = Some(Instant::now() + TERMINATION_GRACE);
        self.memory = memory;
        Ok(())
    }

    fn tick(
        &mut self,
        group: &Group,
        memory: Option<observe::Usage>,
        headroom: u64,
    ) -> io::Result<()> {
        if let Some(deadline) = self.deadline {
            if Instant::now() >= deadline && !self.forced {
                group.send(UnixSignal::SIGKILL)?;
                self.forced = true;
            }
        } else if let Some(sample) = memory
            && sample
                .limit
                .is_some_and(|limit| limit.saturating_sub(sample.used) < headroom)
        {
            self.start(group, UnixSignal::SIGTERM, memory)?;
        }
        Ok(())
    }
}

async fn supervise(
    group: &Group,
    limits: &Limits,
    mut samples: observe::Samples,
    stop: &mut Stops,
) -> io::Result<(observe::Samples, Option<observe::Usage>)> {
    let mut shutdown = Shutdown::default();
    let mut tick = tokio::time::interval(limits.sample_interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = tick.tick() => {
                let memory = samples.measure(limits, group.pid.as_raw());
                if group.exited()? {
                    break;
                }
                shutdown.tick(group, memory, limits.memory_headroom)?;
            }
            signal = stop.next(), if shutdown.deadline.is_none() => {
                shutdown.start(group, signal, None)?;
            }
        }
    }
    Ok((samples, shutdown.memory))
}

struct Tee {
    tail: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}
impl Tee {
    fn start(input: impl Read + Send + 'static, output: impl Write + Send + 'static) -> Self {
        let tail = Arc::new(Mutex::new(Vec::with_capacity(TAIL_BYTES)));
        let shared = Arc::clone(&tail);
        let (send, done) = mpsc::channel();
        std::thread::spawn(move || {
            copy_tail(input, output, &shared);
            let _ = send.send(());
        });
        Self { tail, done }
    }

    fn summary(self) -> Option<usize> {
        // A program outside the owned group might still hold the pipe.
        let _ = self.done.recv_timeout(DRAIN_GRACE);
        let tail = self
            .tail
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        vitest::summary(&tail)
    }
}

fn copy_tail(mut input: impl Read, mut output: impl Write, shared: &Mutex<Vec<u8>>) {
    let mut buffer = [0; 16 * 1024];
    loop {
        let count = match input.read(&mut buffer) {
            Ok(0) => return,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        let mut tail = shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let excess = (tail.len() + count).saturating_sub(TAIL_BYTES);
        tail.drain(..excess);
        tail.extend_from_slice(&buffer[..count]);
        drop(tail);
        let _ = output.write_all(&buffer[..count]);
        let _ = output.flush();
    }
}

pub(super) struct Measured {
    code: i32,
    elapsed: Duration,
    samples: observe::Samples,
    largest_mib: u64,
    watchdog: Option<observe::Usage>,
    files: Option<usize>,
}

impl Measured {
    pub(super) fn report(self, build: &Build, mut record: Value) -> (Value, u8) {
        let mut status = if self.code == 0 { "ok" } else { "failed" };
        let mut exit = self.code as u8;
        if let Some(watchdog) = self.watchdog {
            record["watchdog"] = json!({"used": watchdog.used, "limit": watchdog.limit});
            status = "aborted_memory";
            exit = EX_TEMPFAIL;
        }
        if let Some(expected) = build.expected_files {
            record["expected_files"] = json!(expected);
            record["ran_files"] = json!(self.files);
            if self.watchdog.is_none() && self.files.is_none_or(|ran| ran < expected) {
                let ran = self.files.map_or_else(
                    || "none (no 'Test Files' summary line)".into(),
                    |count| count.to_string(),
                );
                eprintln!("buildenv: expected {expected} test files, vitest ran {ran}");
                status = "fewer-files";
                exit = EX_FEWER_FILES;
            }
        }
        let peak = self.largest_mib.max(self.samples.peak_tree / MIB);
        record["status"] = json!(status);
        record["exit"] = json!(self.code);
        record["seconds"] = json!(tenths(self.elapsed));
        record["peak_mib"] = json!(peak);
        record["peak_rss_mib"] = json!(self.largest_mib);
        record["peak_cgroup_delta_mib"] =
            json!(self.samples.peak_cgroup_delta.map(|bytes| bytes / MIB));
        record["peak_pids_delta"] = json!(self.samples.peak_pids_delta);
        if peak > build.expect / MIB {
            record["warning"] =
                json!("peak memory exceeded the estimate; raise --expect for this command");
        }
        (record, exit)
    }
}

pub(super) async fn run(build: &Build, limits: &Limits, stop: &mut Stops) -> io::Result<Measured> {
    let mut cmd = build.command()?;
    if build.expected_files.is_some() {
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    let samples = observe::Samples::capture(limits);
    stop.before_spawn().await?;
    let started = Instant::now();
    let mut group = Group::spawn(&mut cmd)?;
    let stdout = group
        .child
        .stdout
        .take()
        .map(|pipe| Tee::start(pipe, io::stdout()));
    let stderr = group
        .child
        .stderr
        .take()
        .map(|pipe| Tee::start(pipe, io::stderr()));
    let (samples, watchdog) = supervise(&group, limits, samples, stop).await?;
    let status = group.finish()?;
    // This CLI waits for exactly one build leader. Its children's peak is
    // therefore scoped to this build, including spikes between tree samples.
    let largest_mib =
        u64::try_from(getrusage(UsageWho::RUSAGE_CHILDREN)?.max_rss()).unwrap_or(0) / 1024;
    let stdout = stdout.and_then(Tee::summary);
    let stderr = stderr.and_then(Tee::summary);
    Ok(Measured {
        code: status
            .code()
            .unwrap_or_else(|| -status.signal().unwrap_or(1)),
        elapsed: started.elapsed(),
        samples,
        largest_mib,
        watchdog,
        files: stdout.or(stderr),
    })
}
