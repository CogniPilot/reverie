//! Update the existing ordered Hands state while the room worker is waiting.
use super::{Task, stopped};
use crate::{
    coding_task::{admission::begin, wire::Limits},
    hands_supervisor::state,
    refused,
};
use serde_json::{Map, Value, json, value::to_raw_value};
use std::{io, path::Path};

pub(super) struct Claim {
    pub(super) key: String,
    pub(super) epoch: u64,
}

pub(super) enum Admission {
    Started(Claim),
    Duplicate,
}

pub(super) fn start(path: &Path, room: &str, source: &Value, id: &str) -> io::Result<Admission> {
    let mut original = state::ordered(path)?;
    let mut journal = journal(&original)?;
    let mut statuses = Map::new();
    for (key, raw) in &journal {
        let entry: Value = serde_json::from_str(raw.get())?;
        statuses.insert(key.clone(), entry["status"].clone());
    }
    let mut plan = begin(room, source, id, &statuses);
    if let Some(error) = plan["error"].as_str() {
        return Err(io::Error::other(error.to_owned()));
    }
    if plan["entry"].is_null() {
        return Ok(Admission::Duplicate);
    }
    let epoch = match original.get("_coding_epoch") {
        Some(raw) => serde_json::from_str::<u64>(raw.get())?,
        None => 0,
    }
    .checked_add(1)
    .ok_or_else(refused)?;
    let key = plan["key"].as_str().ok_or_else(refused)?.to_owned();
    let mut entry = plan["entry"].take();
    entry["epoch"] = json!(epoch);
    journal.insert(key.clone(), to_raw_value(&entry)?);
    original.insert("_coding".to_owned(), to_raw_value(&journal)?);
    original.insert("_coding_epoch".to_owned(), to_raw_value(&epoch)?);
    state::save(path, &original)?;
    Ok(Admission::Started(Claim { key, epoch }))
}

fn journal(state: &state::Ordered) -> io::Result<state::Ordered> {
    state.get("_coding").map_or_else(
        || Ok(state::Ordered::new()),
        |value| Ok(serde_json::from_str(value.get())?),
    )
}

pub(super) fn observed_post(path: &Path, room: &str, source: &Value) -> io::Result<bool> {
    let original = state::ordered(path)?;
    let Some(row) = original.get(room) else {
        return Ok(false);
    };
    let row: Value = serde_json::from_str(row.get())?;
    Ok(row["seen"]
        .as_array()
        .is_some_and(|rows| rows.contains(source)))
}

pub(super) fn snapshot(path: &Path) -> io::Result<state::Ordered> {
    let mut book = state::ordered(path)?;
    book.retain(|key, _| matches!(key.as_str(), "_coding" | "_coding_epoch"));
    Ok(book)
}

pub(super) fn update(
    path: &Path,
    claim: &Claim,
    change: impl FnOnce(&mut Value),
) -> io::Result<()> {
    let mut original = state::ordered(path)?;
    let mut journal = journal(&original)?;
    let raw = journal.get_mut(&claim.key).ok_or_else(refused)?;
    let mut row: Value = serde_json::from_str(raw.get())?;
    if row["epoch"].as_u64() != Some(claim.epoch) {
        return Err(refused());
    }
    change(&mut row);
    *raw = to_raw_value(&row)?;
    original.insert("_coding".to_owned(), to_raw_value(&journal)?);
    state::save(path, &original)
}

pub(super) fn prepared_failure(
    path: &Path,
    claim: &Claim,
    profile: &str,
    limits: &Limits,
    reason: &'static str,
) -> io::Result<()> {
    update(path, claim, |row| {
        finish(row, &stopped(reason), profile, limits, None)
    })
}

pub(super) fn complete(
    path: &Path,
    job: &Task,
    result: &Value,
    stats: Option<&Value>,
) -> io::Result<()> {
    update(path, &job.claim, |row| {
        finish(row, result, &job.profile, &job.limits, stats)
    })
}

fn finish(row: &mut Value, result: &Value, profile: &str, limits: &Limits, stats: Option<&Value>) {
    row["status"] = json!(result["status"].as_str().unwrap_or("stopped"));
    row["reason"] = json!(result["reason"].as_str().unwrap_or("worker_failed"));
    row["profile"] = json!(profile);
    row["limits"] = json!(limits);
    for name in [
        "steps",
        "output_bytes",
        "tests_run",
        "test_exit_code",
        "largest_prompt",
        "omitted_rounds",
        "peak_prompt_tokens",
        "context_tokens",
        "model_prompt_tokens",
        "model_output_tokens",
        "tests_current",
        "context_overflows",
        "model_responses",
        "usage_measured_responses",
        "call_retries",
    ] {
        if let Some(value) = result.get(name) {
            row[name] = value.clone();
        }
    }
    if let Some(stats) = stats {
        row["preemptions"] = stats["preemptions"].clone();
        row["model_requests_started"] = stats["requests_started"].clone();
        row["model_watchdogs"] = stats["watchdog_events"].clone();
    }
}

pub(super) fn tool(row: &mut Value, request: &Value, result: &Value, report: Option<&Value>) {
    if let Some(report) = report {
        row["last_runner_report"] = report.clone();
        row["runner_reports"] = json!(number(row, "runner_reports").saturating_add(1));
        row["runner_wall_ms"] =
            json!(number(row, "runner_wall_ms").saturating_add(number(report, "wall_ms")));
        row["runner_peak_rss_bytes"] =
            json!(number(row, "runner_peak_rss_bytes").max(number(report, "peak_rss_bytes")));
    } else {
        row["runner_reports_unavailable"] =
            json!(number(row, "runner_reports_unavailable").saturating_add(1));
    }
    let mut entry =
        json!({"tool":request["name"],"ok":result["ok"],"exit_code":result["exit_code"]});
    if let Some(path) = request["args"]["path"].as_str() {
        entry["path"] = json!(path.chars().take(200).collect::<String>());
    }
    let mut history = row["tool_history"]
        .take()
        .as_array()
        .cloned()
        .unwrap_or_default();
    history.push(entry);
    history.drain(..history.len().saturating_sub(128));
    row["tool_history"] = json!(history);
}

fn number(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or_default()
}
