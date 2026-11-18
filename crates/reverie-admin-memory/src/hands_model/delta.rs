use super::stream::checked_count;
use reverie_host::embeddings::model_api::Failure;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub(super) trait Display {
    fn write(&mut self, kind: DisplayKind, value: &str) -> Result<(), Failure>;
}

#[derive(Clone, Copy)]
pub(super) enum DisplayKind {
    Thinking,
    Answer,
}

impl DisplayKind {
    pub(super) const fn name(self) -> &'static str {
        match self {
            Self::Thinking => "thinking",
            Self::Answer => "answer",
        }
    }
}

#[derive(Deserialize)]
pub(super) struct Event {
    error: Option<Value>,
    model: Option<Value>,
    usage: Option<Value>,
    timings: Option<Value>,
    #[serde(default)]
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default = "first_choice")]
    index: Value,
    delta: Option<Value>,
    finish_reason: Option<Value>,
}

fn first_choice() -> Value {
    json!(0)
}

#[derive(Default, Deserialize)]
struct Delta {
    reasoning_content: Option<String>,
    reasoning: Option<String>,
    content: Option<String>,
    tool_calls: Option<Vec<ToolDelta>>,
}

#[derive(Deserialize)]
struct ToolDelta {
    index: u8,
    id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    function: Option<FunctionDelta>,
}

#[derive(Default, Deserialize)]
struct FunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Default)]
struct Tool {
    id: String,
    name: String,
    arguments: String,
}

struct Budget {
    used: usize,
    limit: usize,
}

impl Budget {
    fn append(&mut self, target: &mut String, delta: Option<&str>) -> Result<(), Failure> {
        if let Some(delta) = delta {
            self.used = checked_count(self.used, delta.len(), self.limit)?;
            target.push_str(delta);
        }
        Ok(())
    }
}

fn tool_calls(calls: BTreeMap<u8, Tool>) -> Result<Value, Failure> {
    if !calls.keys().copied().eq(0..calls.len() as u8) {
        return Err(Failure::Invalid);
    }
    Ok(Value::Array(
        calls
            .into_values()
            .map(|tool| {
                json!({"id": tool.id, "type": "function", "function": {
                    "name": tool.name, "arguments": tool.arguments,
                }})
            })
            .collect(),
    ))
}

pub(super) struct Assembly {
    metadata: Map<String, Value>,
    message: BTreeMap<&'static str, String>,
    calls: BTreeMap<u8, Tool>,
    finish: Option<String>,
    budget: Budget,
}

impl Assembly {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            metadata: Map::new(),
            message: BTreeMap::from([("role", "assistant".into()), ("content", String::new())]),
            calls: BTreeMap::new(),
            finish: None,
            budget: Budget { used: 0, limit },
        }
    }

    pub(super) fn consume(
        &mut self,
        event: Event,
        display: &mut impl Display,
    ) -> Result<(), Failure> {
        if event.error.is_some() {
            return Err(Failure::Invalid);
        }
        for (name, value) in [("usage", event.usage), ("timings", event.timings)] {
            if let Some(value) = value.filter(Value::is_object) {
                self.metadata.insert(name.into(), value);
            }
        }
        if let Some(model) = event.model.filter(Value::is_string) {
            self.metadata.insert("model".into(), model);
        }
        for choice in event.choices {
            if choice.index.as_i64() == Some(0) {
                self.choice(choice, display)?;
            }
        }
        Ok(())
    }

    fn choice(&mut self, choice: Choice, display: &mut impl Display) -> Result<(), Failure> {
        let delta = choice
            .delta
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| Failure::Invalid)?
            .unwrap_or_default();
        let delta: Delta = delta;
        for (field, kind, value) in [
            (
                "reasoning_content",
                DisplayKind::Thinking,
                delta.reasoning_content,
            ),
            ("reasoning", DisplayKind::Thinking, delta.reasoning),
            ("content", DisplayKind::Answer, delta.content),
        ] {
            if let Some(value) = value {
                self.budget
                    .append(self.message.entry(field).or_default(), Some(&value))?;
                display.write(kind, &value)?;
            }
        }
        for delta in delta.tool_calls.unwrap_or_default() {
            self.tool(delta)?;
        }
        if let Some(finish) = choice.finish_reason {
            self.finish = Some(serde_json::from_value(finish).map_err(|_| Failure::Invalid)?);
        }
        Ok(())
    }

    fn tool(&mut self, delta: ToolDelta) -> Result<(), Failure> {
        if delta.index >= 64 || delta.kind.as_deref().is_some_and(|kind| kind != "function") {
            return Err(Failure::Invalid);
        }
        let tool = self.calls.entry(delta.index).or_default();
        let function = delta.function.unwrap_or_default();
        self.budget.append(&mut tool.id, delta.id.as_deref())?;
        self.budget
            .append(&mut tool.name, function.name.as_deref())?;
        self.budget
            .append(&mut tool.arguments, function.arguments.as_deref())
    }

    pub(super) fn finish(mut self) -> Result<Value, Failure> {
        let finish = self.finish.ok_or(Failure::Invalid)?;
        let mut message: Map<String, Value> = self
            .message
            .into_iter()
            .map(|(key, value)| (key.into(), Value::String(value)))
            .collect();
        if !self.calls.is_empty() {
            message.insert("tool_calls".into(), tool_calls(self.calls)?);
        }
        self.metadata.insert(
            "choices".into(),
            json!([{
                "message": message, "finish_reason": finish,
            }]),
        );
        let result = Value::Object(self.metadata);
        let len = serde_json::to_vec(&result)
            .map_err(|_| Failure::Invalid)?
            .len();
        checked_count(0, len, self.budget.limit)?;
        Ok(result)
    }
}
