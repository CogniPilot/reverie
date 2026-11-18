use crate::{database::Database, office::Office, refused};
use reverie_contracts::memory::channel::journal::{JournalCommit, JournalMessage, SourceRevision};
use reverie_core::{
    ids::{ChatMessageId, ChatRoomId},
    operations::JournalDigest,
};
use reverie_store::memory::{JournalEntryId, JournalKey, JournalReceipt, NativeMemoryRead};
use serde::Deserialize;
use serde_json::{
    Value, json,
    value::{self, RawValue},
};
use std::{
    io,
    time::{SystemTime, UNIX_EPOCH},
};

const MISSING: &str =
    "no matching receipt at lookup time; not proof an unknown write never happened";
const FOUND: &str = "durable write receipt only; no semantic or current-source verification";

pub(crate) fn source(
    office: &Office,
    room: &ChatRoomId,
    id: &str,
    captured_end: &RawValue,
) -> io::Result<Box<RawValue>> {
    office.require_membership(room)?;
    let id = ChatMessageId::parse(id).map_err(|_| refused())?;
    let end = SourceRevision::decode(captured_end.get().as_bytes()).ok_or_else(refused)?;
    let current = message(office, room, end.id())?.ok_or_else(refused)?;
    if !current.matches(&end) {
        return Err(refused());
    }
    let selected = message(office, room, &id)?.ok_or_else(refused)?;
    let excerpt = selected.excerpt(&end).ok_or_else(refused)?;
    office.require_membership(room)?;
    Ok(value::to_raw_value(&excerpt)?)
}

fn message(
    office: &Office,
    room: &ChatRoomId,
    id: &ChatMessageId,
) -> io::Result<Option<JournalMessage>> {
    office
        .exact_message(room, id)?
        .map(|raw| JournalMessage::decode(&raw, room, id).ok_or_else(refused))
        .transpose()
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum Reference {
    Entry(i64),
    Turn(String),
}

impl Reference {
    fn key(&self) -> io::Result<JournalKey> {
        match self {
            Self::Entry(id) => JournalEntryId::new(*id)
                .map(JournalKey::Entry)
                .ok_or_else(refused),
            Self::Turn(id) => ChatMessageId::parse(id)
                .map(JournalKey::Turn)
                .map_err(|_| refused()),
        }
    }
}

pub(crate) fn receipt(
    office: &Office,
    room: &ChatRoomId,
    database: &Database,
    reference: &Reference,
    expected: Option<&str>,
) -> io::Result<Box<RawValue>> {
    let key = reference.key()?;
    let expected = expected
        .map(JournalDigest::parse)
        .transpose()
        .map_err(|_| refused())?;
    office.require_membership(room)?;
    let receipt = if let Some(path) = database.existing_file()? {
        NativeMemoryRead::read_journal_receipt(path, &key, expected.as_ref())
            .map_err(|_| refused())?
    } else {
        JournalReceipt::Missing
    };
    office.require_membership(room)?;
    Ok(value::to_raw_value(&receipt_reply(&key, receipt))?)
}

fn receipt_reply(key: &JournalKey, receipt: JournalReceipt) -> Value {
    match receipt {
        JournalReceipt::Committed {
            turn_id,
            entry_id,
            committed_ms,
            digest,
        } => json!({
            "status": "committed", "turn_id": turn_id.as_str(),
            "entry_id": entry_id, "committed_ms": committed_ms, "payload_sha256": digest.as_str(),
            "evidence": FOUND,
        }),
        JournalReceipt::Missing => {
            let mut result = json!({"status": "not_found", "evidence": MISSING});
            insert_key(&mut result, key);
            result
        }
        JournalReceipt::Conflict => {
            let mut result = json!({"status": "conflict"});
            insert_key(&mut result, key);
            result
        }
    }
}

fn insert_key(result: &mut Value, key: &JournalKey) {
    match key {
        JournalKey::Entry(id) => result["entry_id"] = json!(id.get()),
        JournalKey::Turn(id) => result["turn_id"] = json!(id.as_str()),
    }
}

pub(crate) fn previous_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<i64>>, D::Error> {
    Option::<i64>::deserialize(deserializer).map(Some)
}

pub(crate) fn commit(
    office: &Office,
    room: &ChatRoomId,
    database: &Database,
    request: &JournalCommit,
    previous_id: Option<i64>,
) -> io::Result<Box<RawValue>> {
    office.require_membership(room)?;
    if let Some(reason) = evidence_refusal(office, room, request)? {
        office.require_membership(room)?;
        return Ok(value::to_raw_value(
            &json!({"status": "refused", "reason": reason}),
        )?);
    }
    office.require_membership(room)?;
    let store = database.writable()?;
    let result = office.require_membership(room).and_then(|()| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| refused())?;
        store
            .commit_journal(request, previous_id, now.as_secs_f64() * 1000.0)
            .map_err(|_| refused())
    });
    store.close().map_err(|_| refused())?;
    let receipt = result?.ok_or_else(refused)?;
    office.require_membership(room)?;
    let mut reply =
        json!({"status": "committed", "entry_id": receipt.entry_id, "replayed": receipt.replayed});
    if !receipt.replayed {
        reply["coverage"] = json!(request.coverage());
        reply["semantic_review"] = json!("not_performed");
    }
    Ok(value::to_raw_value(&reply)?)
}

fn evidence_refusal(
    office: &Office,
    room: &ChatRoomId,
    request: &JournalCommit,
) -> io::Result<Option<&'static str>> {
    for check in request.sources() {
        let Some(actual) = message(office, room, check.id())? else {
            return Ok(Some("source_unavailable"));
        };
        if let Some(reason) = check.refusal(&actual) {
            return Ok(Some(reason));
        }
    }
    Ok(None)
}
