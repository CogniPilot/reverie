use super::Link;
use crate::automatic;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io;

#[derive(Default, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Memory {
    #[default]
    Disabled,
    Native {
        config: Value,
        timeout_s: f64,
        recall_chars: usize,
    },
    External,
}

impl Memory {
    pub(super) fn recall(&self, link: &mut Link, room: &str, query: &str) -> io::Result<String> {
        let response = self.call(link, room, "recall", json!({"query":query}))?;
        let text = response["text"].as_str().unwrap_or_default();
        if let Self::Native { recall_chars, .. } = self
            && text.chars().count() > *recall_chars
        {
            link.log(json!(["memory unavailable", "recall", "ValueError"]))?;
            return Ok(String::new());
        }
        Ok(text.to_owned())
    }

    pub(super) fn record(&self, link: &mut Link, room: &str, event: Value) -> io::Result<()> {
        self.call(link, room, "record", json!({"event":event}))?;
        Ok(())
    }

    fn call(&self, link: &mut Link, room: &str, op: &str, mut request: Value) -> io::Result<Value> {
        request["op"] = json!(op);
        match self {
            Self::Disabled => Ok(Value::Null),
            Self::External => {
                link.exchange(json!({"effect":"memory","room":room,"request":request}))
            }
            Self::Native {
                config, timeout_s, ..
            } => match automatic::call_worker(config, room, *timeout_s, request) {
                Ok(response) => Ok(response),
                Err(error) => {
                    let name = if error.kind() == io::ErrorKind::TimedOut {
                        "TimeoutExpired"
                    } else {
                        "ValueError"
                    };
                    link.log(json!(["memory unavailable", op, name]))?;
                    Ok(Value::Null)
                }
            },
        }
    }
}
