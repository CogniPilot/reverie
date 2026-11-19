//! Plan and settle one Hands journal save. The transport runs at most one
//! write and, if requested, one read of the exact receipt after it settles.

use crate::refused;
use reverie_contracts::memory::channel::journal::JournalCommit;
use reverie_core::{
    ids::{ChatMessageId, ChatRoomId},
    operations::JournalDigest,
    python_trim_text,
};
use serde::{Deserialize, Serialize};
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};
use std::io;

const DRAFT_BYTES: usize = 8192;
const INVALID: &str = "invalid_arguments_or_source; compress text and use exact source IDs/quotes";
const NEEDS_REASON: &str = "save_needs_reason_this_turn; add --reason WHY";

#[derive(Deserialize, Serialize)]
pub(super) struct Key {
    pub(super) turn_id: String,
    expected_hash: String,
}

impl Key {
    fn check(&self) -> io::Result<()> {
        ChatMessageId::parse(&self.turn_id).map_err(|_| refused())?;
        JournalDigest::parse(&self.expected_hash).map_err(|_| refused())?;
        Ok(())
    }

    fn committed(&self, mut reply: Value, entry_id: i64) -> Next {
        reply["turn_id"] = json!(self.turn_id);
        reply["check_with"] = json!(format!("receipt {}", self.turn_id));
        Next::Reply {
            reply,
            previous_id: Some(entry_id),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Prepare,
    Classify,
    Recover,
}

#[derive(Deserialize)]
struct Job<'a> {
    phase: Phase,
    #[serde(borrow)]
    payload: &'a RawValue,
}

#[derive(Deserialize)]
pub(super) struct Preparation<'a> {
    pub(super) room: String,
    pub(super) read_only: bool,
    pub(super) needs_reason: bool,
    pub(super) arguments: Option<String>,
    #[serde(borrow)]
    pub(super) captured: &'a RawValue,
}

#[derive(Deserialize)]
struct Settlement {
    key: Key,
    result: Option<Value>,
    failure: Option<Failure>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Failure {
    Timeout,
    WorkerError,
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(super) enum Next {
    Commit {
        key: Key,
        draft: Box<RawValue>,
    },
    Receipt,
    Reply {
        reply: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        previous_id: Option<i64>,
    },
}

pub(crate) fn execute(bytes: &[u8]) -> io::Result<impl Serialize + use<>> {
    let job: Job<'_> = serde_json::from_slice(bytes)?;
    let next = match job.phase {
        Phase::Prepare => prepare(&serde_json::from_str(job.payload.get())?),
        Phase::Classify => {
            let input = Settlement::decode(job.payload)?;
            classify(&input.key, input.result)
        }
        Phase::Recover => {
            let input = Settlement::decode(job.payload)?;
            recover(&input.key, input.result.as_ref(), input.failure)
        }
    };
    Ok(next)
}

impl Settlement {
    fn decode(payload: &RawValue) -> io::Result<Self> {
        let input: Self = serde_json::from_str(payload.get())?;
        input.key.check()?;
        Ok(input)
    }
}

pub(super) fn prepare(input: &Preparation<'_>) -> Next {
    if input.read_only {
        return rejection("read_only_request");
    }
    let raw = input.arguments.as_deref().unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(raw).ok();
    if input.needs_reason && !parsed.as_ref().is_some_and(has_reason) {
        return rejection(NEEDS_REASON);
    }
    let Some(draft) = parsed
        .filter(|_| raw.len() <= DRAFT_BYTES)
        .and_then(|draft| to_raw_value(&draft).ok())
    else {
        return rejection(INVALID);
    };
    let Some(commit) = ChatRoomId::parse(&input.room)
        .ok()
        .and_then(|room| JournalCommit::decode(&draft, input.captured, &room))
    else {
        return rejection(INVALID);
    };
    Next::Commit {
        key: Key {
            turn_id: commit.turn_id().as_str().to_owned(),
            expected_hash: commit.digest().as_str().to_owned(),
        },
        draft,
    }
}

fn has_reason(draft: &Value) -> bool {
    draft["annotations"]["reason"]
        .as_str()
        .is_some_and(|reason| !python_trim_text(reason).is_empty())
}

fn rejection(reason: &str) -> Next {
    reply(json!({"status": "refused", "reason": reason}))
}

fn reply(reply: Value) -> Next {
    Next::Reply {
        reply,
        previous_id: None,
    }
}

pub(super) fn classify(key: &Key, result: Option<Value>) -> Next {
    let Some(result) = result.filter(|value| value.as_object().is_some_and(|map| !map.is_empty()))
    else {
        return Next::Receipt;
    };
    match result["status"].as_str() {
        Some("refused") => match source_refusal(result["reason"].as_str()) {
            Some(reason) => {
                reply(json!({"status": "refused", "reason": reason, "turn_id": key.turn_id}))
            }
            None => reply(result),
        },
        Some("committed") => match entry_id(&result) {
            Some(id) => key.committed(result, id),
            None => Next::Receipt,
        },
        Some("unknown") => Next::Receipt,
        _ => reply(result),
    }
}

fn source_refusal(reason: Option<&str>) -> Option<&'static str> {
    match reason? {
        "quote_not_in_source" => Some(
            "quote_not_in_source; nothing was saved. Copy each quote exactly from the cited message",
        ),
        "source_changed" => Some(
            "source_changed; nothing was saved. The cited message changed during this turn; read it again",
        ),
        "source_unavailable" => {
            Some("source_unavailable; nothing was saved. The cited message can no longer be read")
        }
        _ => None,
    }
}

fn entry_id(result: &Value) -> Option<i64> {
    result["entry_id"].as_i64().filter(|id| *id > 0)
}

pub(super) fn recover(key: &Key, result: Option<&Value>, failure: Option<Failure>) -> Next {
    let status = result.and_then(|value| value["status"].as_str());
    if status == Some("conflict") {
        return reply(json!({
            "status": "refused",
            "reason": "operation_payload_conflict",
            "turn_id": key.turn_id,
        }));
    }
    if let Some((id, committed_ms)) = result
        .filter(|_| status == Some("committed"))
        .and_then(|value| matches_receipt(key, value))
    {
        return key.committed(
            json!({
                "status": "committed",
                "entry_id": id,
                "committed_ms": committed_ms,
                "payload_sha256": key.expected_hash,
                "evidence": "durable receipt matched; no semantic or current-source verification",
                "replayed": null,
                "write_retried": false,
                "recovered_after_unknown": true,
            }),
            id,
        );
    }
    let mut unknown = json!({
        "status": "unknown",
        "turn_id": key.turn_id,
        "reason": "write outcome unresolved; do not retry the write",
    });
    if let Some(failure) = failure {
        unknown["failure"] = json!(failure);
    }
    reply(unknown)
}

fn matches_receipt<'a>(key: &Key, result: &'a Value) -> Option<(i64, &'a Value)> {
    let committed_ms = &result["committed_ms"];
    if result["turn_id"] != key.turn_id
        || result["payload_sha256"] != key.expected_hash
        || !committed_ms
            .as_f64()
            .is_some_and(|ms| ms.is_finite() && ms >= 0.0)
    {
        return None;
    }
    Some((entry_id(result)?, committed_ms))
}

#[cfg(test)]
mod tests;
