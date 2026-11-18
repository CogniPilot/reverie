use crate::{database::Database, office::Office, refused};
use reverie_contracts::memory::channel::journal::{JournalMessage, SourceRevision};
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
use std::io;

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
    let current = message(office, room, end.id())?;
    if !current.matches(&end) {
        return Err(refused());
    }
    let selected = message(office, room, &id)?;
    let excerpt = selected.excerpt(&end).ok_or_else(refused)?;
    office.require_membership(room)?;
    Ok(value::to_raw_value(&excerpt)?)
}

fn message(office: &Office, room: &ChatRoomId, id: &ChatMessageId) -> io::Result<JournalMessage> {
    let raw = office.exact_message(room, id)?;
    JournalMessage::decode(&raw, room, id).ok_or_else(refused)
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
