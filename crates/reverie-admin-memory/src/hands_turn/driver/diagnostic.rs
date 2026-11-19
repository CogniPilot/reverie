//! Only fixed status codes and measurements may enter the turn trace.
use super::{Phase, emit};
use crate::worker_channel::WorkerChannel;
use serde_json::{Value, json};
use std::{
    io,
    time::{Duration, Instant},
};

const FINISH: &[&str] = &[
    "stop",
    "length",
    "tool_calls",
    "function_call",
    "content_filter",
    "end_turn",
    "max_tokens",
    "eos",
];
const VERBS: &[&str] = &["save", "recall", "source", "receipt", "map", "help"];
const STATUS: &[&str] = &[
    "available",
    "committed",
    "conflict",
    "not_found",
    "ok",
    "refused",
    "unavailable",
    "unknown",
];
const FAILURE: &[&str] = &["timeout", "worker_error"];
const REASONS: &[&str] = &[
    "journal_unavailable",
    "map_result_budget",
    "operation_payload_conflict",
    "read_only_request",
    "save_needs_reason_this_turn",
    "source_budget",
    "turn_budget",
    "worker_unavailable",
    "source_unavailable",
    "view_unavailable",
    "result_exceeds_budget",
    "invalid_arguments_or_source",
    "source_needs_message_id",
    "receipt_needs_message_id",
];

fn pick<'a>(value: &'a Value, allowed: &[&str]) -> Option<&'a str> {
    if value.is_null() {
        return None;
    }
    Some(
        value
            .as_str()
            .filter(|text| allowed.contains(text))
            .unwrap_or("other"),
    )
}

fn reason(value: &Value) -> Option<&str> {
    if value.is_null() {
        return None;
    }
    let prefix = value
        .as_str()
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim();
    Some(match prefix {
        "write outcome unresolved" => "write_outcome_unresolved",
        code if REASONS.contains(&code) => code,
        _ => "other",
    })
}

fn journal_verb(call: &Value) -> Option<String> {
    let arguments: Value = serde_json::from_str(call["function"]["arguments"].as_str()?).ok()?;
    let verb = arguments["command"].as_str()?.split_whitespace().next()?;
    VERBS.contains(&verb).then(|| verb.to_owned())
}

pub(super) fn journal(channel: &mut WorkerChannel, call: &Value, result: &Value) -> io::Result<()> {
    let verb = journal_verb(call);
    let tool =
        super::super::tool_name(call).filter(|name| super::super::TRACE_TOOLS.contains(name));
    let journal = verb.as_deref().or(tool).unwrap_or("other");
    emit(
        channel,
        &json!({"trace": {
            "journal": journal, "status":pick(&result["status"], STATUS),
            "failure":pick(&result["failure"], FAILURE), "reason":reason(&result["reason"]),
        }}),
    )
}

pub(super) fn model(
    channel: &mut WorkerChannel,
    output: &Value,
    tools: bool,
    outcome: &str,
    characters: usize,
    elapsed: Duration,
) -> io::Result<()> {
    emit(
        channel,
        &json!({
            "observe":"model_done",
            "data": {"seconds":elapsed.as_secs_f64(), "model":output["_model"], "usage":output["_usage"]},
            "trace":{"tools":tools, "finish":pick(&output["_finish_reason"], FINISH), "outcome":outcome,
                     "ms":elapsed.as_millis(), "chars":characters},
            "timing":["model",elapsed.as_secs_f64(),output["_timings"]],
        }),
    )?;
    if output["_token_meter_status"] == "unavailable" {
        emit(
            channel,
            &json!({"observe":"note","data":{
                "text":"Token count unavailable: tokenizer timed out. Character, output and time limits still apply."
            }}),
        )?;
    }
    Ok(())
}

pub(super) fn timing(
    channel: &mut WorkerChannel,
    operation: &str,
    started: Instant,
    details: Value,
) -> io::Result<()> {
    emit(
        channel,
        &json!({"timing":[operation,started.elapsed().as_secs_f64(),details]}),
    )
}

pub(super) fn finish(
    channel: &mut WorkerChannel,
    phase: Phase,
    reason: Option<&str>,
    searches: usize,
) -> io::Result<()> {
    let log = match reason {
        Some("limit") if phase != Phase::Direct => "answer cut at reply limit",
        Some("unusable") => "answer unusable",
        Some("failed") => "answer unusable after retry",
        _ => return Ok(()),
    };
    emit(
        channel,
        &json!({"log":[log,format!("searches={searches}")]}),
    )
}
