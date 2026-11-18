//! The isolated Hands task engine requests every model, authorization and
//! tool effect from the existing controller. It has no network or tool client.
mod channel;
mod session;
#[cfg(test)]
mod tests;
mod wire;

use channel::Channel;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use session::Session;
use std::{io, num::NonZeroU64, time::Duration};
use wire::{Limits, ToolReply};

const FRAME_BYTES: usize = 1_048_576;

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
}

pub(super) fn policy(parent: i32) -> io::Result<()> {
    let raw = crate::worker_input(parent, FRAME_BYTES)?;
    let input: PolicyRequest = serde_json::from_slice(&raw)?;
    input.limits.validate()?;
    let value = match input.frame {
        Some(frame) => match ToolReply::checked(Value::String(frame), &input.limits) {
            Ok((reply, frame)) => json!({"result": reply, "frame": frame}),
            Err(reason) => json!({"error": reason}),
        },
        None => json!({"reserve_chars": input.limits.reserve_chars()}),
    };
    crate::write_reply(&value, FRAME_BYTES)
}
