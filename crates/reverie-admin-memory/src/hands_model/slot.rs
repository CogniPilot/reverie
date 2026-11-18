//! Supervise the one coding model slot while the controller owns authorization
//! and fresh context for each dispatch, including a resume after ordinary chat.
use crate::token_meter::KeyName;
use crate::worker_channel::{WorkerChannel, remaining};
use process::Call;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io;
use std::time::{Duration, Instant};

mod process;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    api_base: String,
    key_env: Option<String>,
    timeout_s: f64,
    max_response_bytes: usize,
    token_meter: Option<Value>,
    events_file: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Submit { seconds: f64 },
    Prepared { payload: Option<Map<String, Value>> },
    Pause,
    Resume,
    Poll,
    Finish,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Reply<'a> {
    Idle,
    Busy,
    Prepare,
    Answer { answer: Value },
    Finished { stats: &'a Stats },
}

#[derive(Default, Serialize)]
struct Stats {
    preemptions: u64,
    requests_started: u64,
    watchdog_events: Vec<Watchdog>,
}

impl Stats {
    fn record_watchdog(&mut self, answer: &Value) {
        let error = answer.get("error").and_then(Value::as_str);
        if let Some(reason) = ["timeout", "model_timeout"]
            .into_iter()
            .find(|reason| Some(*reason) == error)
        {
            self.watchdog_events.push(Watchdog {
                request: self.requests_started,
                reason,
            });
        }
    }
}

#[derive(Serialize)]
struct Watchdog {
    request: u64,
    reason: &'static str,
}

enum Phase {
    Ready,
    Preparing,
    Running(Call),
    Failed(&'static str),
}

struct Pending {
    deadline: Instant,
    phase: Phase,
}

struct Slot {
    settings: Settings,
    suspended: bool,
    pending: Option<Pending>,
    stats: Stats,
}

pub(crate) fn supervise(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let mut channel = WorkerChannel::open()?;
    let first = Instant::now() + Duration::from_secs(2);
    let settings: Settings = channel.read(Some(first))?.ok_or_else(crate::refused)?;
    if let Some(name) = &settings.key_env {
        KeyName::try_from(name.clone()).map_err(io::Error::other)?;
    }
    if settings.request_limit().is_none()
        || !(1..=crate::worker_channel::FRAME_BYTES / 2).contains(&settings.max_response_bytes)
    {
        return Err(crate::refused());
    }
    let mut slot = Slot {
        settings,
        suspended: false,
        pending: None,
        stats: Stats::default(),
    };
    channel.write(&Reply::Idle, Some(first))?;
    while let Some(request) = channel.read(None)? {
        let deadline = Instant::now() + Duration::from_secs(2);
        let reply = slot.handle(request)?;
        channel.write(&reply, Some(deadline))?;
        if matches!(reply, Reply::Finished { .. }) {
            break;
        }
    }
    Ok(())
}

impl Settings {
    fn request_limit(&self) -> Option<Duration> {
        positive_duration(self.timeout_s)
    }
}

impl Slot {
    fn handle(&mut self, request: Request) -> io::Result<Reply<'_>> {
        match request {
            Request::Submit { seconds } => self.submit(seconds),
            Request::Prepared { payload } => self.prepared(payload),
            Request::Pause => self.pause(),
            Request::Resume => {
                self.suspended = false;
                Ok(self.prepare())
            }
            Request::Poll => self.poll(),
            Request::Finish => {
                self.cancel()?;
                Ok(Reply::Finished { stats: &self.stats })
            }
        }
    }

    fn submit(&mut self, seconds: f64) -> io::Result<Reply<'_>> {
        if self.pending.is_some() {
            return Ok(Reply::Busy);
        }
        let now = Instant::now();
        let deadline = now
            .checked_add(positive_duration(seconds).unwrap_or_default())
            .ok_or_else(crate::refused)?;
        self.pending = Some(Pending {
            deadline,
            phase: Phase::Ready,
        });
        Ok(self.prepare())
    }

    fn prepare(&mut self) -> Reply<'_> {
        if let Some(pending) = &mut self.pending
            && !self.suspended
            && matches!(pending.phase, Phase::Ready)
            && remaining(pending.deadline).is_some()
        {
            pending.phase = Phase::Preparing;
            return Reply::Prepare;
        }
        Reply::Idle
    }

    fn prepared(&mut self, payload: Option<Map<String, Value>>) -> io::Result<Reply<'_>> {
        let pending = self
            .pending
            .as_mut()
            .filter(|pending| matches!(pending.phase, Phase::Preparing))
            .ok_or_else(crate::refused)?;
        let Some(payload) = payload else {
            pending.phase = Phase::Failed("model_context_unavailable");
            return Ok(Reply::Idle);
        };
        let limit = self.settings.request_limit().ok_or_else(crate::refused)?;
        let Some(timeout) = remaining(pending.deadline).map(|left| left.min(limit)) else {
            return Ok(Reply::Idle);
        };
        let epoch = self
            .stats
            .requests_started
            .checked_add(1)
            .ok_or_else(crate::refused)?;
        pending.phase = Phase::Running(Call::start(&self.settings, payload, timeout, epoch)?);
        self.stats.requests_started = epoch;
        Ok(Reply::Idle)
    }

    fn pause(&mut self) -> io::Result<Reply<'_>> {
        self.suspended = true;
        if let Some(pending) = &mut self.pending
            && matches!(pending.phase, Phase::Running(_))
            && let Phase::Running(call) = std::mem::replace(&mut pending.phase, Phase::Ready)
        {
            call.cancel()?;
            self.stats.preemptions += 1;
        }
        Ok(Reply::Idle)
    }

    fn cancel(&mut self) -> io::Result<()> {
        if let Some(Pending {
            phase: Phase::Running(call),
            ..
        }) = self.pending.take()
        {
            call.cancel()?;
        }
        Ok(())
    }

    fn poll(&mut self) -> io::Result<Reply<'_>> {
        let Some(pending) = &mut self.pending else {
            return Ok(Reply::Idle);
        };
        let answer = if let Phase::Failed(reason) = pending.phase {
            process::failure(reason)
        } else if remaining(pending.deadline).is_none() {
            // An expired original deadline wins over any buffered completion.
            self.cancel()?;
            process::failure("model_deadline")
        } else if let Phase::Running(call) = &mut pending.phase {
            let Some(answer) = call.take_answer()? else {
                return Ok(Reply::Idle);
            };
            self.stats.record_watchdog(&answer);
            answer
        } else {
            return Ok(Reply::Idle);
        };
        self.pending = None;
        Ok(Reply::Answer { answer })
    }
}

fn positive_duration(seconds: f64) -> Option<Duration> {
    Duration::try_from_secs_f64(seconds)
        .ok()
        .filter(|duration| !duration.is_zero())
}
