//! Own a Hands journal turn from source capture through bounded tool settlement.
mod effects;
pub(super) use effects::{EffectReply, NativeEffect, Settings};

use crate::{
    RESPONSE_BOUND, TURN_CAPTURE_BOUND, refused, turn_capture, turn_context,
    turn_tool::{self, CallState, Merged, Outcome, Toolset},
    worker_channel::WorkerChannel,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::{
    io,
    time::{Duration, Instant},
};

const UNAVAILABLE: &str = "\nJournal unavailable in this turn; no commit or recall command is offered. Do not claim a journal write.";
const INVALID: &str = "invalid_arguments_or_source; compress text and use exact source IDs/quotes";

pub(super) type Effect<'a> = dyn FnMut(Value) -> io::Result<EffectReply> + 'a;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Start {
    room: String,
    history: Box<RawValue>,
    message: Box<RawValue>,
    clock_ms: f64,
    automatic: bool,
    evidence: Option<Value>,
    memory: Option<Settings>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Invoke { call: Value },
    Merge { existing: String, max_chars: usize },
}

#[derive(Default)]
pub(super) struct Turn {
    active: Option<Active>,
    pub(super) context: String,
    recalled: String,
    pub(super) merged_recall: Option<String>,
    recall_context_status: &'static str,
    pub(super) replay: String,
}

struct Active {
    captured: Value,
    read_only: bool,
    previous_id: Option<i64>,
    needs_reason: bool,
    toolset: Toolset,
    calls: CallState,
    expanded: Vec<String>,
}

#[derive(Serialize)]
struct View<'a> {
    context: &'a str,
    recalled: &'a str,
    merged_recall: Option<&'a str>,
    recall_context_status: &'a str,
    replay: &'a str,
    captured: Option<&'a Value>,
    read_only: bool,
    needs_reason: bool,
    calls: usize,
    #[serde(flatten)]
    toolset: Option<&'a Toolset>,
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let mut channel = WorkerChannel::open()?;
    let mut startup: Start = channel
        .read_bounded(Some(deadline(5)), TURN_CAPTURE_BOUND)?
        .ok_or_else(refused)?;
    let native = startup
        .memory
        .take()
        .map(|settings| NativeEffect::new(startup.room.clone(), settings));
    let mut turn = Turn::start(startup, &mut |request| {
        dispatch(&mut channel, native.as_ref(), request)
    });
    channel.write(&turn.view(), Some(deadline(3)))?;
    while let Some(request) = channel.read(None)? {
        let result = match request {
            Request::Invoke { call } => turn.invoke(&call, &mut |request| {
                dispatch(&mut channel, native.as_ref(), request)
            }),
            Request::Merge {
                existing,
                max_chars,
            } => turn.merge(existing, max_chars),
        };
        channel.write(
            &json!({"result": result, "turn": turn.view()}),
            Some(deadline(3)),
        )?;
    }
    Ok(())
}

fn dispatch(
    channel: &mut WorkerChannel,
    native: Option<&NativeEffect>,
    request: Value,
) -> io::Result<EffectReply> {
    if let Some(native) = native {
        if request["op"] == "journal_commit" {
            channel.write(&json!({"write_started": true}), Some(deadline(3)))?;
        }
        return Ok(native.call(request));
    }
    channel.write(&json!({"effect": request}), Some(deadline(3)))?;
    channel.read(Some(deadline(12)))?.ok_or_else(refused)
}

fn deadline(seconds: u64) -> Instant {
    Instant::now() + Duration::from_secs(seconds)
}

impl Turn {
    pub(super) fn tools(&self) -> &[Value] {
        self.active
            .as_ref()
            .map_or(&[], |active| &active.toolset.tools)
    }

    pub(super) fn names(&self) -> Vec<String> {
        self.active
            .as_ref()
            .filter(|active| active.calls.calls < active.toolset.call_limit)
            .map_or_else(Vec::new, |active| {
                active
                    .toolset
                    .accepted_calls
                    .iter()
                    .map(|name| (*name).to_owned())
                    .collect()
            })
    }

    pub(super) fn start(job: Start, effect: &mut Effect<'_>) -> Self {
        Self::capture(job, effect).unwrap_or_else(|_| Self {
            context: UNAVAILABLE.into(),
            recall_context_status: "not_available",
            replay: "{}".into(),
            ..Self::default()
        })
    }

    fn capture(job: Start, effect: &mut Effect<'_>) -> io::Result<Self> {
        let raw = serde_json::to_vec(&json!({
            "room": job.room, "history": job.history, "message": job.message,
        }))?;
        let capture = turn_capture::execute(&raw)?;
        if serde_json::to_vec(&capture)?.len() >= crate::AUTOMATIC_BOUND {
            return Err(refused());
        }
        let captured: Value = serde_json::from_str(capture.captured.get())?;
        let status = effect(if job.automatic {
            json!({"op": "journal_status", "query": &capture.query})
        } else {
            json!({"op": "journal_status"})
        })?;
        let status = status.result.ok_or_else(refused)?;
        if status["status"] != "available" {
            return Err(refused());
        }
        let read_only = capture.read_only;
        let projected = project(job, capture, &captured, &status)?;
        let prompt = projected.context.ok_or_else(refused)?;
        let mut turn = Self {
            context: prompt.text,
            recall_context_status: if projected.recall.is_empty() {
                "unavailable_or_unsupported"
            } else {
                "prepared"
            },
            recalled: projected.recall,
            replay: "{}".into(),
            active: Some(Active {
                captured,
                read_only,
                previous_id: prompt.previous_id,
                needs_reason: prompt.needs_reason,
                toolset: prompt.toolset,
                calls: CallState::default(),
                expanded: Vec::new(),
            }),
            ..Self::default()
        };
        if let Some(merged) = prompt.merged {
            turn.merged_recall = Some(turn.apply_merge(merged));
        }
        Ok(turn)
    }

    fn view(&self) -> View<'_> {
        let active = self.active.as_ref();
        View {
            context: &self.context,
            recalled: &self.recalled,
            merged_recall: self.merged_recall.as_deref(),
            recall_context_status: self.recall_context_status,
            replay: &self.replay,
            captured: active.map(|active| &active.captured),
            read_only: active.is_some_and(|active| active.read_only),
            needs_reason: active.is_some_and(|active| active.needs_reason),
            calls: active.map_or(0, |active| active.calls.calls),
            toolset: active.map(|active| &active.toolset),
        }
    }

    fn merge(&mut self, existing: String, max_chars: usize) -> Value {
        match turn_tool::merge(self.recalled.clone(), existing, &self.context, max_chars) {
            Ok(merged) => json!(self.apply_merge(merged)),
            Err(_) => json!({"error": "recalled evidence exceeds configured cap"}),
        }
    }

    fn apply_merge(&mut self, merged: Merged) -> String {
        if let Some(status) = merged.status {
            self.recall_context_status = status;
        }
        if let Some(note) = merged.context_note {
            self.context.push_str(note);
        }
        merged.text
    }

    pub(super) fn invoke(&mut self, call: &Value, effect: &mut Effect<'_>) -> Value {
        let Some(active) = &mut self.active else {
            return json!({"status": "refused", "reason": "journal_unavailable"});
        };
        let function = &call["function"];
        let name = function["name"].as_str().map(str::to_owned);
        let arguments = function["arguments"]
            .as_str()
            .filter(|raw| raw.chars().count() <= crate::AUTOMATIC_BOUND)
            .map(str::to_owned);
        let step = turn_tool::invoke(
            active.read_only,
            std::mem::take(&mut active.calls),
            name,
            arguments,
        );
        active.calls = step.state;
        self.replay = step.replay;
        match step.outcome {
            Outcome::Reply { reply } => reply,
            Outcome::Dispatch { dispatch } => active.dispatch(dispatch, effect),
        }
    }
}

fn project(
    job: Start,
    capture: turn_capture::Capture,
    captured: &Value,
    status: &Value,
) -> io::Result<turn_context::Presentation> {
    let mut input = json!({
        "room": job.room, "capsule": &status["recall"],
        "turn": {
            "captured_end": &captured["end"],
            "checkpoint": status.get("checkpoint").filter(|value| crate::hands_settings::truthy(value)),
            "clock_ms": job.clock_ms,
            "catalog": capture.catalog,
            "read_only": capture.read_only,
            "asked_to_remember": capture.asked_to_remember,
            "evidence": job.evidence,
        },
    });
    let mut raw = serde_json::to_vec(&input)?;
    if raw.len() > RESPONSE_BOUND {
        input["capsule"] = Value::Null;
        raw = serde_json::to_vec(&input)?;
    }
    if raw.len() > RESPONSE_BOUND {
        return Err(refused());
    }
    turn_context::execute(&raw)
}
