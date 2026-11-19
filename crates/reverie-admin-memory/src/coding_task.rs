//! The isolated Hands task engine requests every model, authorization and
//! tool effect from the existing controller. It has no network or tool client.
mod admission;
pub(super) use admission::workspace_call;
mod channel;
mod diagnostics;
mod session;
mod settings;
#[cfg(test)]
mod tests;
mod wire;

use crate::worker_channel::FRAME_BYTES;
pub(super) use admission::admit;
use channel::Channel;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use session::Session;
pub(super) use settings::{admin_task, check_coding, tool_export};
use std::{io, num::NonZeroU64, time::Duration};
use wire::{Limits, ToolReply};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    epoch: NonZeroU64,
    messages: Vec<Value>,
    tools: Vec<Value>,
    limits: Limits,
    options: Map<String, Value>,
}

pub(super) trait Controller {
    fn remaining(&self) -> Option<Duration>;
    fn ask(&mut self, kind: &str, payload: Value) -> io::Result<Value>;
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let mut wire = Channel::open()?;
    let input: Start = wire.receive()?;
    let epoch = input.epoch;
    wire.start(epoch, input.limits.task_duration()?)?;
    let result = match Session::new(input) {
        Ok(session) => json!({"epoch": epoch, "kind": "result", "result": session.run(&mut wire)}),
        Err(_) => json!({"epoch": epoch, "kind": "failed", "error": "worker_failed"}),
    };
    wire.finish(&result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyRequest {
    limits: Limits,
    frame: Option<String>,
    diagnostics: Option<String>,
}

pub(super) fn policy(parent: i32) -> io::Result<()> {
    let raw = crate::worker_input(parent, FRAME_BYTES)?;
    let input: PolicyRequest = serde_json::from_slice(&raw)?;
    input.limits.validate()?;
    if input.frame.is_none() && input.diagnostics.is_none() {
        return crate::write_reply(
            &json!({"reserve_chars": input.limits.reserve_chars()}),
            FRAME_BYTES,
        );
    }
    let mut value = match input.frame {
        Some(frame) => match ToolReply::checked(Value::String(frame), &input.limits) {
            Ok((reply, _)) => json!({"result": reply}),
            Err(reason) => json!({"error": reason}),
        },
        None => json!({}),
    };
    value["report"] = input
        .diagnostics
        .as_deref()
        .and_then(diagnostics::report)
        .unwrap_or(Value::Null);
    crate::write_reply(&value, FRAME_BYTES)
}
