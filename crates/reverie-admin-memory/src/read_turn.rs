//! Plan and settle a bounded journal read. The existing Office worker
//! remains responsible for grants, room membership and live sources.

use crate::journal::Reference;
use reverie_contracts::memory::channel::journal::{append_exact_source, canonical_journal_output};
use reverie_core::ids::ChatMessageId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io;

mod topic_map;

const ARGUMENT_BYTES: usize = 8192;
const RESULT_CHARS: usize = 2400;
const MAX_EXPANSIONS: usize = 2;
const INVALID: &str = "invalid_arguments_or_source; compress text and use exact source IDs/quotes";

#[derive(Deserialize, Serialize)]
#[serde(tag = "op")]
enum Request {
    #[serde(rename = "journal_source")]
    Source {
        message_id: String,
        captured_end: Value,
    },
    #[serde(rename = "journal_receipt")]
    Receipt { turn_id: Reference },
    #[serde(rename = "journal_view")]
    View { query: String },
    #[serde(rename = "journal_recall")]
    Recall { query: String },
}

#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum Job {
    Plan {
        tool: String,
        arguments: Option<String>,
        captured_end: Value,
        expanded_sources: Vec<String>,
    },
    Settle {
        request: Request,
        result: Value,
        captured: Value,
        failure: Option<String>,
    },
}

pub(crate) fn execute(bytes: &[u8]) -> io::Result<Value> {
    Ok(match serde_json::from_slice::<Job>(bytes)? {
        Job::Plan {
            tool,
            arguments,
            captured_end,
            expanded_sources,
        } => {
            let request = arguments.as_deref().and_then(arguments_object);
            request
                .as_ref()
                .and_then(|args| plan(&tool, args, captured_end, &expanded_sources))
                .unwrap_or_else(|| refusal(INVALID))
        }
        Job::Settle {
            request,
            result,
            captured,
            failure,
        } => settle(request, result, captured, failure.as_deref())
            .unwrap_or_else(|| refusal(INVALID)),
    })
}

fn arguments_object(raw: &str) -> Option<Value> {
    if raw.len() > ARGUMENT_BYTES {
        return None;
    }
    let args: Value = serde_json::from_str(raw).ok()?;
    (args.as_object()?.len() == 1).then_some(args)
}

fn plan(tool: &str, args: &Value, captured_end: Value, expanded: &[String]) -> Option<Value> {
    let request = match tool {
        "journal_map" => {
            let query = args.get("query")?.as_str()?;
            if query.chars().count() > 300 {
                return None;
            }
            Request::View {
                query: query.to_owned(),
            }
        }
        "journal_recall" => Request::Recall {
            query: args.get("query")?.as_str()?.to_owned(),
        },
        "journal_receipt" => return Some(receipt(args.get("turn_id")?)),
        "journal_source" => return Some(source(args.get("message_id")?, captured_end, expanded)),
        _ => return None,
    };
    Some(effect(request))
}

fn receipt(id: &Value) -> Value {
    if let Some(id) = id.as_str() {
        if entry_number(id) && !id.starts_with('0') {
            return effect(Request::Receipt {
                turn_id: Reference::Entry(id.parse().expect("bounded decimal entry number")),
            });
        }
        if ChatMessageId::parse(id).is_ok() {
            return effect(Request::Receipt {
                turn_id: Reference::Turn(id.to_owned()),
            });
        }
    }
    id_refusal(
        id,
        "receipt",
        "the full turn_id from the save result (the message that asked for it)",
    )
}

fn source(id: &Value, captured_end: Value, expanded: &[String]) -> Value {
    let Some(id) = id.as_str().filter(|id| ChatMessageId::parse(id).is_ok()) else {
        return id_refusal(
            id,
            "source",
            "a full message ID from a recalled entry's source_ids",
        );
    };
    if !expanded.iter().any(|previous| previous == id) && expanded.len() >= MAX_EXPANSIONS {
        return refusal("source_budget");
    }
    effect(Request::Source {
        message_id: id.to_owned(),
        captured_end,
    })
}

fn entry_number(value: &str) -> bool {
    (1..=9).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn id_refusal(value: &Value, verb: &str, hint: &str) -> Value {
    let seen = value
        .as_str()
        .filter(|id| entry_number(id))
        .map_or_else(String::new, |id| format!("{id} looks like an entry_id. "));
    refusal(&format!("{verb}_needs_message_id; {seen}Use {hint}"))
}

fn effect(request: Request) -> Value {
    json!({"request": request})
}

fn reply(result: Value) -> Value {
    json!({"reply": result})
}

fn refusal(reason: &str) -> Value {
    reply(json!({"status": "refused", "reason": reason}))
}

fn unavailable(reason: Option<&str>, failure: Option<&str>) -> Value {
    let mut value = json!({"status": "unavailable"});
    if let Some(reason) = reason {
        value["reason"] = json!(reason);
    }
    if let Some(failure @ ("timeout" | "worker_error")) = failure {
        value["failure"] = json!(failure);
    }
    reply(value)
}

fn empty(result: &Value) -> bool {
    result.as_object().is_none_or(serde_json::Map::is_empty)
}

fn settle(
    request: Request,
    result: Value,
    mut captured: Value,
    failure: Option<&str>,
) -> Option<Value> {
    match request {
        Request::View { .. } => topic_map::settle(&result, &captured, failure),
        Request::Source { message_id, .. } => {
            if result["status"] != "available" {
                return Some(unavailable(Some("source_unavailable"), failure));
            }
            if !fits(&result) {
                return None;
            }
            append_exact_source(&mut captured, &message_id, &result)?;
            Some(json!({"reply": result, "captured": captured, "expanded_id": message_id}))
        }
        Request::Receipt { turn_id } => {
            if empty(&result) {
                return Some(unavailable(None, failure));
            }
            if result["status"] == "committed" && !receipt_matches(&turn_id, &result) {
                return None;
            }
            Some(reply(result))
        }
        Request::Recall { .. } if empty(&result) => Some(unavailable(None, failure)),
        Request::Recall { .. } => Some(reply(result)),
    }
}

fn receipt_matches(reference: &Reference, result: &Value) -> bool {
    let Some(id) = result["turn_id"]
        .as_str()
        .filter(|id| ChatMessageId::parse(id).is_ok())
    else {
        return false;
    };
    match reference {
        Reference::Entry(entry) => result["entry_id"].as_i64() == Some(*entry),
        Reference::Turn(expected) => id == expected,
    }
}

fn fits(value: &Value) -> bool {
    canonical_journal_output(value).is_some_and(|text| text.chars().count() <= RESULT_CHARS)
}

#[cfg(test)]
mod tests;
