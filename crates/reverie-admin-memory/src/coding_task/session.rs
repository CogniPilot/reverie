mod report;

use super::{
    Controller, Start,
    wire::{Call, FRAME, Limits, OMITTED, STEP_CHARS, Tool, ToolReply, permitted_tools},
};
use regex_lite::Regex;
pub(super) use report::Report;
use serde_json::{Map, Value, json};
use std::{
    collections::{HashSet, VecDeque},
    io,
    sync::LazyLock,
    time::Duration,
};

static THINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<think>.*?</think>").unwrap());
static MARKUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</?tool_call\b|<\|tool_call|<function[=\s>]").unwrap());

const CALL_REPAIR_LIMIT: usize = 2;
const PARALLEL_NOTE: &str = "Your previous response requested multiple tools. None of those calls ran. Return exactly one tool call in your next response, then wait for its result before requesting another.";
const INVALID_NOTE: &str = "Your previous tool call was invalid and did not run. Use exactly one offered tool, a valid call ID and a JSON object matching its arguments. Wait for its result before requesting another tool.";

type Outcome<T> = Result<T, &'static str>;

enum Action {
    Continue,
    Complete(String),
}

pub(super) struct Session {
    messages: Vec<Value>,
    tools: Vec<Value>,
    options: Map<String, Value>,
    permitted: HashSet<Tool>,
    limits: Limits,
    rounds: VecDeque<[Value; 2]>,
    used_ids: HashSet<String>,
    repair_note: Option<&'static str>,
    report: Report,
}

impl Session {
    pub(super) fn new(mut start: Start) -> io::Result<Self> {
        start.limits.validate()?;
        if start.messages.is_empty()
            || start.options.contains_key("messages")
            || start.options.contains_key("tools")
        {
            return Err(crate::refused());
        }
        start
            .options
            .insert("parallel_tool_calls".into(), Value::Bool(false));
        Ok(Self {
            messages: start.messages,
            permitted: permitted_tools(&start.tools)?,
            tools: start.tools,
            options: start.options,
            limits: start.limits,
            rounds: VecDeque::new(),
            used_ids: HashSet::new(),
            repair_note: None,
            report: Report::default(),
        })
    }

    pub(super) fn run(mut self, controller: &mut impl Controller) -> Report {
        match self.execute(controller) {
            Ok(text) => self.report.complete(text),
            Err(reason) => self.report.stop(reason),
        }
    }

    fn execute(&mut self, controller: &mut impl Controller) -> Outcome<String> {
        let initial = prompt_size(&self.payload())?;
        if initial.saturating_add(self.limits.reserve_chars()) > self.limits.prompt_chars {
            return Err("prompt_reserve");
        }
        loop {
            if let Action::Complete(text) = self.round(controller)? {
                return Ok(text);
            }
        }
    }

    fn payload(&self) -> Value {
        let mut messages = self.messages.clone();
        if self.report.omitted_rounds > 0 {
            messages.push(system_message(OMITTED));
        }
        messages.extend(self.rounds.iter().flatten().cloned());
        if let Some(note) = self.repair_note {
            messages.push(system_message(note));
        }
        let mut request = self.options.clone();
        request.insert("messages".into(), Value::Array(messages));
        request.insert("tools".into(), Value::Array(self.tools.clone()));
        Value::Object(request)
    }

    fn bounded_request(&mut self) -> Outcome<Value> {
        loop {
            let request = self.payload();
            let size = prompt_size(&request)?;
            if size <= self.limits.prompt_chars {
                self.report.largest_prompt = self.report.largest_prompt.max(size);
                return Ok(request);
            }
            self.omit_round().map_err(|_| "prompt_limit")?;
        }
    }

    fn omit_round(&mut self) -> Outcome<()> {
        if self.rounds.len() <= 1 {
            return Err("context_limit");
        }
        self.rounds.pop_front();
        self.report.omitted_rounds += 1;
        Ok(())
    }

    fn round(&mut self, controller: &mut impl Controller) -> Outcome<Action> {
        authorize(controller)?;
        remaining(controller)?;
        let request = self.bounded_request()?;
        let timeout = remaining(controller)?.as_secs_f64();
        let response = controller
            .ask("model", json!({"request": request, "timeout": timeout}))
            .map_err(|_| "model_failed")?;
        remaining(controller)?;
        let response = response.as_object().ok_or("invalid_model_result")?;
        self.report.measure(response)?;
        if response.get("_context_overflow") == Some(&Value::Bool(true)) {
            self.report.context_overflows += 1;
            self.omit_round()?;
            return Ok(Action::Continue);
        }
        self.report.usage(response);
        let content = response.get("content").filter(|value| truthy(value));
        let content =
            content.map_or(Ok(""), |value| value.as_str().ok_or("invalid_model_result"))?;
        let text = THINK.replace_all(content, "");
        let text = reverie_core::memory::trim_text(&text);
        match response.get("tool_calls").filter(|value| truthy(value)) {
            Some(calls) => self.tool_step(controller, calls, text),
            None if text.is_empty() || MARKUP.is_match(text) => Err("unusable_reply"),
            None => Ok(Action::Complete(prefix(text, 2400))),
        }
    }

    fn tool_step(
        &mut self,
        controller: &mut impl Controller,
        calls: &Value,
        text: &str,
    ) -> Outcome<Action> {
        if self.report.steps >= self.limits.steps {
            return Err("step_limit");
        }
        let remaining_bytes = self.limits.total_bytes - self.report.output_bytes;
        if remaining_bytes == 0 {
            return Err("total_output_limit");
        }
        self.report.steps += 1;
        let call = self.parse_call(calls);
        let call = match call {
            Ok(call) => call,
            Err(reason) => return self.repair(reason),
        };
        self.repair_note = None;
        if !self.used_ids.insert(call.id.clone()) {
            return Err("duplicate_call");
        }
        self.invoke(controller, call, text, remaining_bytes)?;
        Ok(Action::Continue)
    }

    fn parse_call(&self, calls: &Value) -> Outcome<Call> {
        let Some([call]) = calls.as_array().map(Vec::as_slice) else {
            return Err("parallel_calls_refused");
        };
        Call::parse(call, &self.permitted, &self.limits).map_err(|_| "invalid_call")
    }

    fn repair(&mut self, reason: &'static str) -> Outcome<Action> {
        if self.report.call_retries >= CALL_REPAIR_LIMIT {
            return Err(reason);
        }
        self.report.call_retries += 1;
        self.repair_note = Some(match reason {
            "parallel_calls_refused" => PARALLEL_NOTE,
            _ => INVALID_NOTE,
        });
        Ok(Action::Continue)
    }

    fn invoke(
        &mut self,
        controller: &mut impl Controller,
        call: Call,
        text: &str,
        remaining_bytes: usize,
    ) -> Outcome<()> {
        authorize(controller)?;
        let operation = self.limits.operation_duration().map_err(|_| "time_limit")?;
        let timeout = remaining(controller)?.min(operation).as_secs_f64();
        let cap = self.limits.wire_bytes.min(remaining_bytes);
        let value = controller
            .ask(
                "tool",
                json!({"request": call.request(), "timeout": timeout, "cap": cap}),
            )
            .map_err(|_| "runner_failed")?;
        remaining(controller)?;
        let (reply, frame) =
            ToolReply::checked(value, &self.limits).map_err(|_| "runner_protocol")?;
        if frame.len() > remaining_bytes {
            return Err("total_output_limit");
        }
        self.report.output_bytes += frame.len();
        if let Some(reason) = reply.fatal() {
            return Err(reason);
        }
        self.report.tool(&call, &reply);
        self.rounds.push_back([
            json!({"role": "assistant", "content": prefix(text, STEP_CHARS), "tool_calls": [call.canonical()]}),
            json!({"role": "tool", "tool_call_id": call.id, "content": format!("{FRAME}{frame}")}),
        ]);
        controller
            .ask(
                "progress",
                json!({"step": self.report.steps, "tool": call.tool,
            "ok": reply.ok, "error": reply.error, "truncated": reply.truncated}),
            )
            .map(|_| ())
            .map_err(|_| "progress_failed")
    }
}

fn system_message(content: &str) -> Value {
    json!({"role": "system", "content": content})
}

fn prompt_size(value: &Value) -> Outcome<usize> {
    serde_json::to_string(value)
        .map(|line| line.chars().count())
        .map_err(|_| "prompt_limit")
}

fn prefix(value: &str, chars: usize) -> String {
    let end = value
        .char_indices()
        .nth(chars)
        .map_or(value.len(), |(end, _)| end);
    value[..end].to_owned()
}

fn remaining(controller: &impl Controller) -> Outcome<Duration> {
    controller.remaining().ok_or("time_limit")
}

fn authorize(controller: &mut impl Controller) -> Outcome<()> {
    match controller.ask("authorize", Value::Null).as_ref().ok() {
        Some(Value::Null) => Ok(()),
        Some(Value::String(reason)) if reason == "cancelled" => Err("cancelled"),
        Some(Value::String(reason)) if reason == "revoked" => Err("revoked"),
        Some(Value::String(reason)) if reason == "not_member" => Err("not_member"),
        Some(Value::String(reason)) if reason == "silent" => Err("silent"),
        _ => Err("authorization_unavailable"),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}
