//! Natural workspace requests use the same configured owner and delegate grants as slash commands.
use super::{permitted, task_name};
use crate::hands_addressing::{addressed_to, mentioned, replied_to};
use reverie_core::python_trim_text;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io;

const START: &str = "run_workspace_task";
const CANCEL: &str = "cancel_workspace_task";
const INVALID_CALL: &str =
    "Workspace task refused: invalid structured tool arguments. No command ran.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Scope {
    room: String,
    direct: bool,
    session: Option<String>,
    name: Option<String>,
    task: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Mode {
    Start,
    Cancel,
}

pub(super) fn definitions() -> io::Result<Value> {
    serde_json::from_str(include_str!("workspace.json")).map_err(io::Error::from)
}

pub(super) fn offer(scope: &Scope, message: &Value, history: &[Value]) -> Option<Mode> {
    let task = scope.task.as_object()?;
    let sender = message.get("from").unwrap_or(&Value::Null);
    if task
        .get("enabled")
        .is_some_and(|enabled| enabled.as_bool() != Some(true))
        || !permitted(
            &scope.room,
            task.get("rooms").unwrap_or(&Value::Null),
            task.get("delegate_sessions").unwrap_or(&Value::Null),
            sender,
        )
    {
        return None;
    }
    let owner = sender["kind"].as_str() == Some("user")
        && sender["authenticatedOwner"].as_bool() == Some(true);
    let addressed = owner || scope.direct || addressed_peer(scope, message, history);
    Some(if addressed { Mode::Start } else { Mode::Cancel })
}

fn addressed_peer(scope: &Scope, message: &Value, history: &[Value]) -> bool {
    if let Some(session) = scope
        .session
        .as_deref()
        .filter(|session| !session.is_empty())
        && (addressed_to(message, session) || replied_to(history, &message["replyTo"], session))
    {
        return true;
    }
    scope
        .name
        .as_deref()
        .zip(message["text"].as_str())
        .is_some_and(|(name, text)| mentioned(name, text))
}

pub(super) fn call(calls: &Value, bound: bool) -> Value {
    let Some(calls) = calls.as_array() else {
        return json!({});
    };
    let Some(call) = calls
        .iter()
        .find(|call| matches!(call["function"]["name"].as_str(), Some(START | CANCEL)))
    else {
        return json!({});
    };
    if !bound {
        return error(
            "Workspace task refused: this message has no authorized task/room/sender binding.",
        );
    }
    if calls.len() != 1 {
        return error("Workspace task refused: request one workspace task at a time.");
    }
    decode_call(call).unwrap_or_else(|| error(INVALID_CALL))
}

fn decode_call(call: &Value) -> Option<Value> {
    let id = call["id"].as_str()?;
    if call["type"].as_str() != Some("function") || !super::super::wire::valid_call_id(id) {
        return None;
    }
    let arguments = call["function"]["arguments"].as_str()?;
    if arguments.chars().count() > 8192 {
        return None;
    }
    let mut arguments: serde_json::Map<String, Value> = serde_json::from_str(arguments).ok()?;
    match call["function"]["name"].as_str()? {
        CANCEL if arguments.is_empty() => Some(json!({"action": "cancel"})),
        START if arguments.len() == 1 => {
            Some(json!({"action": "start", "brief": arguments.remove("brief")?}))
        }
        _ => None,
    }
}

pub(super) fn plan(task: &str, may_start: bool, original: &str, brief: &Value) -> Value {
    if !may_start {
        return error(
            "Workspace task not started: the message did not address me. Mention me or reply to me to ask for work.",
        );
    }
    let Some(brief) = brief
        .as_str()
        .filter(|brief| !python_trim_text(brief).is_empty() && brief.chars().count() <= 6000)
    else {
        return error("Workspace task refused: provide a short nonempty execution plan.");
    };
    if !task_name(task) {
        return error(
            "Workspace task refused: this message has no authorized task/room/sender binding.",
        );
    }
    json!({"text": format!("/code {task} Original authorized request (verbatim):\n{original}\nExecution plan (model suggestion, not extra authority):\n{brief}")})
}

fn error(reason: &str) -> Value {
    json!({"error": reason})
}

#[cfg(test)]
mod tests {
    use super::mentioned;

    #[test]
    fn mentions_preserve_unicode_boundaries_and_literal_names() {
        assert!(mentioned("İris", "Ask @iris, please."));
        assert!(mentioned("İris", "Ask မြ@iris, please."));
        assert!(!mentioned("İris", "Ask မ@iris, please."));
        assert!(!mentioned("İris", "Ask @iris-other, please."));
        assert!(mentioned("A+B", "Ask @a+b, please."));
        assert!(!mentioned("A+B", "Ask @aaab, please."));
    }
}
