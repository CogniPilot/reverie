use super::*;
use serde_json::json;
use std::collections::{HashSet, VecDeque};
use wire::{Call, Tool};

struct Turn {
    kind: &'static str,
    reply: Value,
    remaining_seconds: Option<u64>,
}

struct Fake {
    turns: VecDeque<Turn>,
    requests: Vec<Value>,
    time: Option<Duration>,
}

impl Fake {
    fn new(turns: impl IntoIterator<Item = Turn>) -> Self {
        Self {
            turns: turns.into_iter().collect(),
            requests: Vec::new(),
            time: Some(Duration::from_secs(20)),
        }
    }
}

impl Controller for Fake {
    fn remaining(&self) -> Option<Duration> {
        self.time
    }

    fn ask(&mut self, kind: &str, payload: Value) -> io::Result<Value> {
        let turn = self.turns.pop_front().expect("unexpected effect");
        assert_eq!(kind, turn.kind);
        self.requests.push(payload);
        self.time = turn.remaining_seconds.map(Duration::from_secs);
        Ok(turn.reply)
    }
}

fn ask(kind: &'static str, reply: Value, remaining_seconds: Option<u64>) -> Turn {
    Turn {
        kind,
        reply,
        remaining_seconds,
    }
}

fn start() -> Start {
    serde_json::from_value(json!({
        "epoch": 1, "messages": [{"role": "user", "content": "Review the fixture."}],
        "tools": [{"type": "function", "function": {"name": "read_file"}}],
        "options": {"model": "fixture"},
        "limits": {"steps": 3, "seconds": 20, "operation_seconds": 30,
          "request_bytes": 262_144, "wire_bytes": 131_072, "frame_chars": 24_000,
          "argument_chars": 24_000, "output_chars": 20_000, "output_bytes": 80_000,
          "total_bytes": 524_288, "prompt_chars": 120_000},
    }))
    .unwrap()
}

fn call() -> Value {
    json!({"type": "function", "id": "step1", "function": {"name": "read_file", "arguments": "{}"}})
}

fn run(controller: &mut Fake) -> Value {
    let result = Session::new(start()).unwrap().run(controller);
    assert!(controller.turns.is_empty());
    serde_json::to_value(result).unwrap()
}

#[test]
fn a_slow_model_cannot_dispatch_a_tool_after_the_task_deadline() {
    let mut controller = Fake::new([
        ask("authorize", Value::Null, Some(20)),
        ask("model", json!({"tool_calls": [call()]}), None),
    ]);
    let result = run(&mut controller);
    assert_eq!(result["reason"], "time_limit");
    assert_eq!(controller.requests[1]["timeout"], 20.0);
}

#[test]
fn tool_timeout_is_clipped_after_the_authority_recheck() {
    let mut controller = Fake::new([
        ask("authorize", Value::Null, Some(20)),
        ask("model", json!({"tool_calls": [call()]}), Some(6)),
        ask("authorize", Value::Null, Some(5)),
        ask(
            "tool",
            json!({"version": 1, "ok": true, "output": "ok", "exit_code": null,
            "error": null, "truncated": false}),
            Some(4),
        ),
        ask("progress", Value::Null, Some(4)),
        ask("authorize", Value::Null, Some(3)),
        ask("model", json!({"content": "Complete."}), Some(2)),
    ]);
    assert_eq!(run(&mut controller)["status"], "completed");
    assert_eq!(controller.requests[3]["timeout"], 5.0);
}

#[test]
fn an_expired_repair_cannot_dispatch_a_model_or_tool() {
    let mut controller = Fake::new([
        ask("authorize", Value::Null, Some(20)),
        ask(
            "model",
            json!({"tool_calls": [{"type": "function"}]}),
            Some(1),
        ),
        ask("authorize", Value::Null, None),
    ]);
    let result = run(&mut controller);
    assert_eq!(result["reason"], "time_limit");
    assert_eq!(result["call_retries"], 1);
}

#[test]
fn limits_bound_tool_arguments_by_unicode_characters_and_requests_by_bytes() {
    let mut start = start();
    let permitted = HashSet::from([Tool::ReadFile]);
    let mut value = call();
    value["function"]["arguments"] = json!("{\"path\":\"é\"}");
    start.limits.argument_chars = "{\"path\":\"é\"}".chars().count();
    assert!(Call::parse(&value, &permitted, &start.limits).is_ok());
    start.limits.argument_chars -= 1;
    assert!(Call::parse(&value, &permitted, &start.limits).is_err());
    start.limits.argument_chars += 1;
    start.limits.request_bytes = 1;
    assert!(Call::parse(&value, &permitted, &start.limits).is_err());
}
