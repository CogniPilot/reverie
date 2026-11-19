//! OpenCode delegates Office journal operations to the installed journal client.
use super::Result;
use crate::capture::{self, Limits, Signals};
use serde_json::{Map, Value, json};
use std::{
    io,
    process::Command,
    time::{Duration, Instant},
};

pub(super) fn remember(mut fields: Map<String, Value>) -> Result<Value> {
    let private = fields
        .get("project")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty);
    let mut frame = json!({"action":"remember", "private":private});
    for key in [
        "text", "project", "room", "turn", "tag", "quote", "source", "reason",
    ] {
        if let Some(value) = fields.remove(key) {
            frame[key] = value;
        }
    }
    call(
        &frame,
        "journal save was not confirmed; inspect the journal before another save",
    )?
    .map_err(Into::into)
}

pub(super) fn call(frame: &Value, unconfirmed: &str) -> Result<std::result::Result<Value, String>> {
    let signals = Signals::install()?;
    let mut child = Command::new("reverie-memory-journal");
    child.arg("--journal-only");
    let request = serde_json::to_vec(frame)?;
    let limits = Limits::worker(
        Instant::now() + Duration::from_secs(45),
        crate::OPENCODE_CONTEXT_BOUND,
        &signals,
    );
    match capture::completed(child, Some(&request), limits) {
        Ok(output) if output.success => {
            Ok(serde_json::from_slice(&output.stdout).map_err(|_| unconfirmed.to_owned()))
        }
        Ok(output) => Ok(Err(
            journal_error(&output.stderr).unwrap_or_else(|| unconfirmed.to_owned())
        )),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Err(error.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Err(
            "the packaged Office journal client is unavailable".into(),
        )),
        Err(_) => Ok(Err(unconfirmed.into())),
    }
}

fn journal_error(stderr: &[u8]) -> Option<String> {
    let last_line = std::str::from_utf8(stderr).ok()?.lines().last()?;
    let error: Value = serde_json::from_str(last_line).ok()?;
    Some(error.get("error")?.as_str()?.to_owned())
}
