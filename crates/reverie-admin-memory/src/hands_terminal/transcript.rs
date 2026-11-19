use super::Settings;
use crate::hands_model::{TraceKind, redact_trace};
use jiff::Timestamp;
use regex_lite::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    io::{self, Write},
    sync::LazyLock,
    time::Instant,
};

const ROWS: usize = 200;
const TEXT_CHARS: usize = 12_000;
const LINE_BYTES: usize = 196_608;

static CONTROL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|\z)|\x1b\[[0-?]*[ -/]*[@-~]")
        .expect("valid escape sequence pattern")
});
static SECRET_QUERY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)((?:api[_-]?key|token|password|secret)=)[^&\s"']+"#)
        .expect("valid credential query pattern")
});

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Observation {
    Poll,
    Idle,
    Rooms {
        count: usize,
    },
    Incoming {
        sender: String,
        room: String,
        text: String,
    },
    ModelStart {
        chars: usize,
    },
    ModelDone {
        seconds: f64,
        model: Option<Value>,
        usage: Option<Value>,
    },
    Posting,
    Reply {
        room: String,
        text: String,
        confirmed: bool,
    },
    LocalReply {
        room: String,
        text: String,
    },
    Error {
        text: String,
    },
    Note {
        text: String,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Normal,
    Reply,
    Error,
    Trace(TraceKind),
}

pub(super) struct Row {
    pub(super) stamp: String,
    pub(super) kind: Kind,
    pub(super) text: String,
}

impl Row {
    pub(super) fn display_text(&self) -> String {
        match self.kind {
            Kind::Trace(kind) => format!("[{}] {}\n{}", self.stamp, trace_caption(kind), self.text),
            _ => format!("[{}] {}", self.stamp, self.text),
        }
    }
}

pub(super) struct Transcript {
    pub(super) settings: Settings,
    pub(super) records: VecDeque<Row>,
    pub(super) revision: u64,
    parent: i32,
    endpoint: String,
    phase: &'static str,
    phase_since: Instant,
    polls: u64,
    errors: u64,
    replies: u64,
    rooms: usize,
    last_poll: String,
    api_model: String,
    usage: String,
    plain: bool,
    lines: Vec<String>,
    line_bytes: usize,
}

impl Transcript {
    pub(super) fn new(parent: i32, settings: Settings, plain: bool) -> Self {
        let endpoint = clean(&settings.secrets, &endpoint(&settings.api_base));
        Self {
            settings,
            records: VecDeque::with_capacity(ROWS),
            revision: 0,
            parent,
            endpoint,
            phase: "Starting",
            phase_since: Instant::now(),
            polls: 0,
            errors: 0,
            replies: 0,
            rooms: 0,
            last_poll: "not yet".into(),
            api_model: "unverified".into(),
            usage: "not reported".into(),
            plain,
            lines: Vec::new(),
            line_bytes: 0,
        }
    }

    pub(super) fn use_plain_output(&mut self) {
        self.plain = true;
    }

    pub(super) fn title(&self) -> String {
        self.clean(&format!(
            "Reverie Admin Harness | {} | configured: {} | PID {}",
            self.settings.self_name, self.settings.model, self.parent
        ))
    }

    pub(super) fn model_line(&self) -> String {
        self.clean(&format!(
            "{} | API model: {}",
            self.endpoint, self.api_model
        ))
    }

    pub(super) fn state_line(&self) -> String {
        format!(
            "{} ({:.1}s) | last poll {} UTC | rooms {} | errors {}",
            self.phase,
            self.phase_since.elapsed().as_secs_f64(),
            self.last_poll,
            self.rooms,
            self.errors,
        )
    }

    pub(super) fn summary(&self, phone: &str) -> String {
        self.clean(&format!(
            "Reverie Admin Harness / PID {} | configured model: {}\n\
             Endpoint: {} | API-reported model: {}\n\
             General scan: {}s | phone wake: {}\n\
             State: {} | polls: {}, rooms: {}, posted replies: {}, errors: {}\n\
             Prompt cap: {} characters; reply cap: {} tokens | usage: {}\n\
             Coding: {}; search: {}; memory recall: {}",
            self.parent,
            self.settings.model,
            self.endpoint,
            self.api_model,
            self.settings.poll_s,
            phone,
            self.phase,
            self.polls,
            self.rooms,
            self.replies,
            self.errors,
            self.settings.prompt_cap_chars,
            self.settings.reply_max_tokens,
            self.usage,
            enabled(self.settings.coding),
            enabled(self.settings.search),
            enabled(self.settings.memory),
        ))
    }

    pub(super) fn observe(&mut self, event: Observation) {
        use Observation::*;
        match event {
            Poll => {
                self.set_phase("Polling rooms");
                self.polls = self.polls.saturating_add(1);
                self.last_poll = stamp();
            }
            Idle => self.set_phase("Waiting for messages"),
            Rooms { count } => self.rooms = count,
            Incoming { sender, room, text } => {
                self.set_phase("Preparing reply");
                self.note(&format!("{sender} [{room}]\n{text}"));
            }
            ModelStart { chars } => {
                self.set_phase("Waiting for model");
                self.note(&format!("Model request: {chars} characters"));
            }
            ModelDone {
                seconds,
                model,
                usage,
            } => self.model_done(seconds, model, usage),
            Posting => self.set_phase("Posting room reply"),
            Reply {
                room,
                text,
                confirmed,
            } => {
                self.replies = self.replies.saturating_add(u64::from(confirmed));
                let label = if confirmed {
                    "posted"
                } else {
                    "post returned without a receipt"
                };
                self.reply(&room, &text, label);
            }
            LocalReply { room, text } => self.reply(&room, &text, "terminal"),
            Error { text } => {
                self.errors = self.errors.saturating_add(1);
                self.set_phase("Error; loop will retry");
                self.record(Kind::Error, &format!("ERROR: {text}"));
            }
            Note { text } => self.note(&text),
        }
    }

    fn model_done(&mut self, seconds: f64, model: Option<Value>, usage: Option<Value>) {
        self.set_phase("Model answered");
        if let Some(Value::String(model)) =
            model.filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
        {
            self.api_model = self.clean(&model);
        }
        if let Some(Value::Object(usage)) = usage {
            self.usage = usage
                .iter()
                .filter(|(key, _)| {
                    matches!(
                        key.as_str(),
                        "prompt_tokens" | "completion_tokens" | "total_tokens"
                    )
                })
                .filter_map(|(key, value)| value.as_u64().map(|count| format!("{key}={count}")))
                .collect::<Vec<_>>()
                .join(", ");
            if self.usage.is_empty() {
                self.usage = "not reported".into();
            }
        }
        self.note(&format!(
            "Model answered in {seconds:.2}s | API model: {}",
            self.api_model
        ));
    }

    fn reply(&mut self, room: &str, text: &str, label: &str) {
        self.set_phase("Waiting for messages");
        self.record(
            Kind::Reply,
            &format!("{} [{room}; {label}]\n{text}", self.settings.self_name),
        );
    }

    pub(super) fn note(&mut self, text: &str) {
        self.record(Kind::Normal, text);
    }

    fn set_phase(&mut self, phase: &'static str) {
        self.phase = phase;
        self.phase_since = Instant::now();
    }

    fn record(&mut self, kind: Kind, text: &str) {
        let text = self.clean(text);
        let stamp = stamp();
        self.line(format!("[{stamp}] {text}"));
        self.push(Row { stamp, kind, text });
    }

    fn push(&mut self, row: Row) {
        if self.records.len() == ROWS {
            self.records.pop_front();
        }
        self.records.push_back(row);
        self.revision = self.revision.wrapping_add(1);
    }

    pub(super) fn clear(&mut self) {
        self.records.clear();
        self.revision = self.revision.wrapping_add(1);
    }

    pub(super) fn trace(&mut self, events: impl Iterator<Item = (TraceKind, String)>) {
        let mut group: Option<(TraceKind, String)> = None;
        for (kind, delta) in events {
            if group.as_ref().is_some_and(|(current, _)| *current != kind)
                && let Some((kind, text)) = group.take()
            {
                self.trace_row(kind, &text);
            }
            group
                .get_or_insert_with(|| (kind, String::new()))
                .1
                .push_str(&delta);
        }
        if let Some((kind, text)) = group {
            self.trace_row(kind, &text);
        }
    }

    fn trace_row(&mut self, trace: TraceKind, delta: &str) {
        let label = trace_caption(trace);
        let phase = if trace == TraceKind::Thinking {
            "Thinking"
        } else {
            "Receiving answer"
        };
        if self.phase != phase {
            self.set_phase(phase);
        }
        let kind = Kind::Trace(trace);
        let mut text = self.clean(delta);
        let mut stamp = stamp();
        self.line(format!("[{stamp}] {label}: {text}"));
        if self.records.back().is_some_and(|row| row.kind == kind)
            && let Some(previous) = self.records.pop_back()
        {
            stamp = previous.stamp;
            let mut joined = previous.text;
            joined.push_str(&text);
            text = joined;
        }
        if text.chars().count() > TEXT_CHARS {
            let offset = text
                .char_indices()
                .rev()
                .nth(TEXT_CHARS - 100)
                .map_or(0, |(offset, _)| offset);
            text = format!("[earlier trace text omitted]\n{}", &text[offset..]);
        }
        self.push(Row { stamp, kind, text });
    }

    pub(super) fn line(&mut self, text: String) {
        if !self.plain {
            return;
        }
        if self.settings.capture {
            if self.line_bytes.saturating_add(text.len()) <= LINE_BYTES {
                self.line_bytes += text.len();
                self.lines.push(text);
            }
        } else {
            let _ = writeln!(io::stdout().lock(), "{text}");
        }
    }

    pub(super) fn drain_lines(&mut self) -> Vec<String> {
        self.line_bytes = 0;
        std::mem::take(&mut self.lines)
    }

    pub(super) fn clean(&self, text: &str) -> String {
        clean(&self.settings.secrets, text)
    }
}

fn trace_caption(kind: TraceKind) -> &'static str {
    match kind {
        TraceKind::Thinking => "Thinking",
        TraceKind::Answer => "Answer stream",
    }
}

fn stamp() -> String {
    Timestamp::now().strftime("%H:%M:%S").to_string()
}

fn enabled(value: bool) -> &'static str {
    if value { "enabled" } else { "off" }
}

fn endpoint(uri: &str) -> String {
    let Some((scheme, rest)) = uri.split_once("://") else {
        return "(invalid endpoint)".into();
    };
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let (authority, path) = rest
        .split_once('/')
        .map_or((rest, None), |(host, path)| (host, Some(path)));
    let host = authority
        .rsplit('@')
        .next()
        .filter(|host| !host.is_empty())
        .unwrap_or("?");
    path.map_or_else(
        || format!("{scheme}://{host}"),
        |path| format!("{scheme}://{host}/{path}"),
    )
}

fn clean(secrets: &[String], raw: &str) -> String {
    let mut text = CONTROL.replace_all(raw, "").into_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        text = text.replace(secret, "[redacted]");
    }
    let text = SECRET_QUERY.replace_all(&text, "${1}[redacted]");
    redact_trace(&text)
        .replace('\t', "    ")
        .chars()
        .take(TEXT_CHARS)
        .collect()
}

#[cfg(test)]
mod tests;
