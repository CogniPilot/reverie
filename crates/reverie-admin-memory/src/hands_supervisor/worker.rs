use crate::{TURN_CAPTURE_BOUND, capture::Signals, refused, worker_channel::WorkerChannel};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    env, io,
    os::{
        fd::OwnedFd,
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(super) enum Kind {
    Poll,
    Answer,
    Terminal,
    Attention,
    Coding,
    ModelSlot(Option<String>),
}

pub(super) struct Worker {
    channel: WorkerChannel,
    child: Child,
    grace: Duration,
}

impl Worker {
    pub(super) fn start(kind: Kind, initial: &impl serde::Serialize) -> io::Result<Self> {
        let (local, peer) = UnixStream::pair()?;
        let channel = WorkerChannel::from_fd(&local)?;
        let peer = Stdio::from(OwnedFd::from(peer));
        let mut command = Command::new(env::current_exe()?);
        let flag = match &kind {
            Kind::Poll => "hands-tick-worker",
            Kind::Answer => "hands-answer-worker",
            Kind::Terminal => "hands-native-terminal-worker",
            Kind::Attention => "hands-attention-worker",
            Kind::Coding => "hands-coding-worker",
            Kind::ModelSlot(_) => "hands-model-slot-worker",
        };
        command.arg(format!("--{flag}={}", std::process::id()));
        if matches!(kind, Kind::Terminal) {
            command
                .env_clear()
                .env("TERM", env::var_os("TERM").unwrap_or_default())
                .env("LANG", "C.UTF-8")
                .stderr(peer);
        } else {
            command
                .process_group(0)
                .stdin(peer)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
        restrict_coding_environment(&kind, &mut command);
        let grace = Duration::from_millis(if matches!(kind, Kind::Terminal) {
            1000
        } else {
            100
        });
        let child = command.spawn()?;
        let mut worker = Self {
            channel,
            child,
            grace,
        };
        worker.send(initial)?;
        Ok(worker)
    }

    pub(super) fn send(&mut self, value: &impl serde::Serialize) -> io::Result<()> {
        self.channel.write_bounded(
            value,
            Some(Instant::now() + Duration::from_secs(5)),
            TURN_CAPTURE_BOUND,
        )
    }

    pub(super) fn receive(&mut self, seconds: Duration, signals: &Signals) -> io::Result<Value> {
        self.receive_as(seconds, &|| signals.check())
    }

    pub(super) fn receive_as<T: DeserializeOwned>(
        &mut self,
        seconds: Duration,
        check: &dyn Fn() -> io::Result<()>,
    ) -> io::Result<T> {
        let deadline = Instant::now().checked_add(seconds).ok_or_else(refused)?;
        self.channel
            .read_checked(deadline, TURN_CAPTURE_BOUND, check)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "Hands worker exited"))
    }

    pub(super) fn copy_receiver(&self) -> io::Result<WorkerChannel> {
        self.channel.duplicate()
    }

    pub(super) fn ready(&mut self) -> io::Result<Option<Value>> {
        self.channel.poll()
    }
}

fn restrict_coding_environment(kind: &Kind, command: &mut Command) {
    if matches!(kind, Kind::Coding | Kind::ModelSlot(_)) {
        command
            .env_clear()
            .env("PATH", "/bin:/usr/bin")
            .env("LANG", "C.UTF-8");
    }
    if let Kind::ModelSlot(Some(key)) = kind
        && let Some(value) = env::var_os(key)
    {
        command.env(key, value);
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.channel.shutdown();
        let deadline = Instant::now() + self.grace;
        while let Ok(None) = self.child.try_wait() {
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}
