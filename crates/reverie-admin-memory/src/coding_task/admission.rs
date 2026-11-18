//! Decisions over the controller's current message, grants, and journal.
use super::settings::task_name;
use reverie_core::python_trim_text;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::io;

mod workspace;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Control {
        text: String,
        agent: bool,
    },
    Sender {
        room: String,
        rooms: Value,
        delegates: Value,
        sender: Value,
    },
    Begin {
        room: String,
        source_id: Value,
        task_id: String,
        statuses: Map<String, Value>,
    },
    Interrupt {
        statuses: Map<String, Value>,
    },
    WorkspaceDefinitions,
    WorkspaceOffer {
        scope: workspace::Scope,
        message: Value,
        history: Vec<Value>,
    },
    WorkspaceCall {
        calls: Value,
        bound: bool,
    },
    WorkspacePlan {
        task: String,
        may_start: bool,
        original: String,
        brief: Value,
    },
}

#[derive(Serialize)]
struct Control<'a> {
    action: &'static str,
    task_id: &'a str,
    brief: &'a str,
}

pub(crate) fn admit(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, crate::worker_channel::FRAME_BYTES)?;
    let request: Request = serde_json::from_slice(&input)?;
    let reply = match request {
        Request::Control { text, agent } => json!({"control": control(&text, agent)}),
        Request::Sender {
            room,
            rooms,
            delegates,
            sender,
        } => {
            json!({"permitted": permitted(&room, &rooms, &delegates, &sender)})
        }
        Request::Begin {
            room,
            source_id,
            task_id,
            statuses,
        } => begin(&room, &source_id, &task_id, &statuses),
        Request::Interrupt { statuses } => {
            let keys: Vec<_> = statuses
                .iter()
                .filter(|(_, status)| status.as_str() == Some("started"))
                .map(|(key, _)| key.as_str())
                .collect();
            json!({"keys": keys})
        }
        Request::WorkspaceDefinitions => workspace::definitions()?,
        Request::WorkspaceOffer {
            scope,
            message,
            history,
        } => {
            json!({"mode": workspace::offer(&scope, &message, &history)})
        }
        Request::WorkspaceCall { calls, bound } => workspace::call(&calls, bound),
        Request::WorkspacePlan {
            task,
            may_start,
            original,
            brief,
        } => workspace::plan(&task, may_start, &original, &brief),
    };
    crate::write_reply(&reply, crate::worker_channel::FRAME_BYTES)
}

fn control(text: &str, agent: bool) -> Option<Control<'_>> {
    let text = if agent {
        text.strip_prefix("[external agent] ").unwrap_or(text)
    } else {
        text
    };
    let (action, rest) = match text.strip_prefix("/code-cancel ") {
        Some(rest) => ("cancel", rest),
        None => ("start", text.strip_prefix("/code ")?),
    };
    let boundary = rest
        .find(|character: char| python_trim_text(character.encode_utf8(&mut [0; 4])).is_empty())
        .unwrap_or(rest.len());
    let (task_id, suffix) = rest.split_at(boundary);
    if !task_name(task_id) {
        return None;
    }
    let brief = python_trim_text(suffix);
    Some(Control {
        action,
        task_id,
        brief,
    })
}

fn includes(values: &Value, name: &str) -> bool {
    values
        .as_array()
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(name)))
}

fn permitted(room: &str, rooms: &Value, delegates: &Value, sender: &Value) -> bool {
    if !includes(rooms, room) {
        return false;
    }
    match sender.get("kind").and_then(Value::as_str) {
        Some("user") => sender.get("authenticatedOwner").and_then(Value::as_bool) == Some(true),
        Some("agent") => sender
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|session| !session.is_empty() && includes(delegates, session)),
        _ => false,
    }
}

fn begin(room: &str, source: &Value, task: &str, statuses: &Map<String, Value>) -> Value {
    let Some(source) = source
        .as_str()
        .filter(|source| !source.is_empty() && source.chars().count() <= 200)
    else {
        return json!({"error": "invalid source id"});
    };
    let key = format!("{room}:{source}");
    if statuses.contains_key(&key)
        || statuses
            .values()
            .any(|status| status.as_str() == Some("started"))
    {
        return json!({"entry": null});
    }
    if statuses.len() >= 500 {
        return json!({"error": "journal capacity; operator rotation required"});
    }
    json!({"key": key, "entry": {"task_id": task, "status": "started", "reason": null}})
}

#[cfg(test)]
mod tests {
    use super::{begin, control};
    use serde_json::{Map, Value, json};

    #[test]
    fn directive_requires_an_exact_identifier_and_real_separator() {
        let parsed = control(
            "[external agent] /code-cancel fixture-1\u{1c}  Fix it\u{a0}",
            true,
        )
        .expect("agent cancel directive");
        assert_eq!(
            (parsed.action, parsed.task_id, parsed.brief),
            ("cancel", "fixture-1", "Fix it")
        );
        assert!(control("[external agent] /code fixture", false).is_none());
        assert!(control("/code fixture/other", false).is_none());
        assert!(control("/code fixtureé", false).is_none());
        assert!(control(&format!("/code {}", "a".repeat(64)), false).is_some());
        assert!(control(&format!("/code {}", "a".repeat(65)), false).is_none());
    }

    #[test]
    fn journal_refuses_replay_before_applying_capacity() {
        let mut statuses: Map<String, Value> = (0..500)
            .map(|id| (format!("room:{id}"), json!("stopped")))
            .collect();
        assert_eq!(
            begin("room", &json!("0"), "task", &statuses),
            json!({"entry": null})
        );
        assert_eq!(
            begin("room", &json!("new"), "task", &statuses),
            json!({"error": "journal capacity; operator rotation required"})
        );
        statuses.insert("room:0".into(), json!("started"));
        assert_eq!(
            begin("room", &json!("new"), "task", &statuses),
            json!({"entry": null})
        );
        assert_eq!(
            begin("room", &json!("é".repeat(201)), "task", &statuses),
            json!({"error": "invalid source id"})
        );
    }
}
