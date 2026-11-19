//! Terminal input and display for Hands. The session carries observations and prompts, never tool calls.
mod screen;
mod transcript;

use crate::{hands_model::TraceReader, worker_channel::WorkerChannel};
use screen::Screen;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{self, IsTerminal},
    path::PathBuf,
    sync::mpsc::{Receiver, RecvTimeoutError, sync_channel},
    thread,
    time::{Duration, Instant},
};
use transcript::{Observation, Transcript};

const REFRESH: Duration = Duration::from_millis(100);
const INPUTS: usize = 16;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    interactive: bool,
    capture: bool,
    api_base: String,
    model: String,
    self_name: String,
    poll_s: f64,
    prompt_cap_chars: usize,
    reply_max_tokens: usize,
    message_cap_chars: usize,
    coding: bool,
    search: bool,
    memory: bool,
    trace: Option<PathBuf>,
    secrets: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Observe { event: Observation },
    Status { phone_wake: String },
    Poll { take_input: bool },
    Clear,
    Stop,
}

#[derive(Default, Serialize)]
struct Reply {
    lines: Vec<String>,
    summary: Option<String>,
    prompt: Option<String>,
    pending: bool,
    interactive: bool,
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    // EOF on the private socket also shuts down the view if the supervisor
    // exits abruptly. Keep the renderer alive long enough to restore termios.
    crate::check_worker_parent(parent)?;
    let mut channel = WorkerChannel::from_fd(io::stderr())?;
    let settings = channel.read(None)?.ok_or_else(crate::refused)?;
    let mut incoming = WorkerChannel::from_fd(io::stderr())?;
    let (sender, receiver) = sync_channel(1);
    let reader = thread::spawn(move || {
        while let Ok(Some(command)) = incoming.read(None) {
            if sender.send(command).is_err() {
                break;
            }
        }
    });
    let result = Session::start(parent, settings, &receiver, &mut channel);
    drop(receiver);
    let _ = channel.shutdown();
    let _ = reader.join();
    result
}

pub(super) fn run_detached(parent: i32) -> io::Result<()> {
    if nix::unistd::getppid().as_raw() != parent {
        return Err(crate::refused());
    }
    nix::unistd::setsid()?;
    run(parent)
}

struct Session {
    transcript: Transcript,
    screen: Option<Screen>,
    input: VecDeque<String>,
    trace: Option<TraceReader>,
}

impl Session {
    fn start(
        parent: i32,
        settings: Settings,
        incoming: &Receiver<Command>,
        outgoing: &mut WorkerChannel,
    ) -> io::Result<()> {
        let wants_screen = settings.interactive
            && io::stdin().is_terminal()
            && io::stdout().is_terminal()
            && std::env::var("TERM").is_ok_and(|term| !term.is_empty() && term != "dumb");
        let screen = wants_screen.then(Screen::open).transpose();
        let failed = screen.is_err();
        let screen = screen.unwrap_or_default();
        let trace = settings
            .trace
            .as_deref()
            .map(|path| TraceReader::new(path, true))
            .transpose();
        let trace_failed = trace.is_err();
        let mut view = Self {
            transcript: Transcript::new(parent, settings, screen.is_none()),
            screen,
            input: VecDeque::with_capacity(INPUTS),
            trace: trace.unwrap_or_default(),
        };
        if view.screen.is_none() {
            let summary = view.transcript.summary("not started");
            view.transcript.line(summary);
        }
        if failed {
            view.transcript
                .note("Interactive terminal unavailable; using plain harness diagnostics.");
        }
        if trace_failed {
            view.trace_failure();
        }
        view.send(outgoing, Reply::default())?;
        view.run(incoming, outgoing)
    }

    fn run(
        &mut self,
        incoming: &Receiver<Command>,
        outgoing: &mut WorkerChannel,
    ) -> io::Result<()> {
        let mut next_frame = Instant::now();
        loop {
            if Instant::now() >= next_frame {
                next_frame = Instant::now() + REFRESH;
                self.refresh();
            }
            match incoming.recv_timeout(next_frame.saturating_duration_since(Instant::now())) {
                Ok(Command::Stop) => {
                    self.stop();
                    return self.send(outgoing, Reply::default());
                }
                Ok(command) => {
                    let reply = self.command(command);
                    self.send(outgoing, reply)?;
                }
                Err(RecvTimeoutError::Timeout) => (),
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
    }

    fn command(&mut self, command: Command) -> Reply {
        let mut reply = Reply::default();
        match command {
            Command::Observe { event } => {
                if matches!(event, Observation::ModelDone { .. }) {
                    self.drain_trace(16);
                }
                self.transcript.observe(event);
            }
            Command::Status { phone_wake } => {
                reply.summary = Some(self.transcript.summary(&phone_wake));
            }
            Command::Poll { take_input } => {
                if take_input {
                    reply.prompt = self.input.pop_front();
                }
            }
            Command::Clear => self.transcript.clear(),
            Command::Stop => unreachable!("stop closes the terminal before the reply"),
        }
        reply
    }

    fn send(&mut self, channel: &mut WorkerChannel, mut reply: Reply) -> io::Result<()> {
        reply.lines = self.transcript.drain_lines();
        reply.pending = !self.input.is_empty();
        reply.interactive = self.screen.is_some();
        channel.write(&reply, Some(Instant::now() + Duration::from_secs(1)))
    }

    fn refresh(&mut self) {
        self.drain_trace(1);
        let Some(screen) = &mut self.screen else {
            return;
        };
        if screen
            .refresh(&mut self.transcript, &mut self.input)
            .is_err()
        {
            self.screen.take();
            self.transcript.use_plain_output();
            self.transcript
                .note("Interactive terminal unavailable; using plain harness diagnostics.");
        }
    }

    fn drain_trace(&mut self, polls: usize) {
        let Some(reader) = &mut self.trace else {
            return;
        };
        for _ in 0..polls {
            match reader.poll() {
                Ok(events) if events.is_empty() => break,
                Ok(events) => self
                    .transcript
                    .trace(events.into_iter().map(|event| (event.kind, event.text))),
                Err(_) => {
                    self.trace_failure();
                    break;
                }
            }
        }
    }

    fn trace_failure(&mut self) {
        self.trace = None;
        self.transcript
            .note("Model trace unavailable: private-file checks failed.");
    }

    fn stop(&mut self) {
        self.drain_trace(16);
        self.screen.take();
        self.transcript.use_plain_output();
        self.transcript
            .line("Reverie Admin Harness stopped.".into());
    }
}
