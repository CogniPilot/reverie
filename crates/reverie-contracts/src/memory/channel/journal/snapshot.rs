//! Bounded turn evidence captured from messages already visible to Hands.

use super::{
    JournalMessage, Timestamp, WireRevision, canonical_json, field, scalar, write::Coverage,
};
use crate::legacy_json::{decode_memory_str, ordered::OrderedValue};
use crate::memory::{object, string};
use reverie_core::ids::{ChatMessageId, ChatRoomId};
use serde::{Deserialize, Serialize};
use serde_json::value::{self, RawValue};
use std::collections::BTreeMap;

const VISIBLE_LIMIT: usize = 12;
const CATALOG_CHARS: usize = 160;

#[derive(Deserialize)]
struct Input<'a> {
    room: &'a str,
    #[serde(borrow)]
    message: &'a RawValue,
    #[serde(borrow)]
    history: Vec<&'a RawValue>,
}

struct Candidate<'a> {
    at: Timestamp,
    raw: &'a RawValue,
}

#[derive(Serialize)]
struct WireSnapshot<'a> {
    room: &'a str,
    end: WireRevision<'a>,
    events: Vec<WireRevision<'a>>,
    coverage: &'static str,
}

/// Captured revisions and their exact visible text. Only the Office effect
/// worker can verify that the revisions and room membership are still current.
pub struct JournalSnapshot {
    room: ChatRoomId,
    end: JournalMessage,
    selected: Vec<JournalMessage>,
}

impl JournalSnapshot {
    pub fn decode(input: &[u8]) -> Option<Self> {
        let input: Input<'_> = serde_json::from_slice(input).ok()?;
        let room = ChatRoomId::parse(input.room).ok()?;
        let current = decode_memory_str(input.message.get().as_bytes()).ok()?;
        let id = ChatMessageId::parse(&scalar(field(&current.value, "id")?)?).ok()?;
        let end = JournalMessage::observed(&current, &room, &id)?;
        let current = Candidate {
            at: Timestamp::decode(field(&current.value, "at")?)?,
            raw: input.message,
        };
        let selected = visible_rows(input.history, current, &room, &end)?;
        Some(Self {
            room,
            end,
            selected,
        })
    }

    pub fn request_text(&self) -> &str {
        &self.end.text
    }

    pub fn captured(&self) -> Option<Box<RawValue>> {
        let events = self
            .selected
            .iter()
            .map(|row| row.revision.wire())
            .collect::<Option<Vec<_>>>()?;
        value::to_raw_value(&WireSnapshot {
            room: self.room.as_str(),
            end: self.end.revision.wire()?,
            events,
            coverage: Coverage::Visible.as_str(),
        })
        .ok()
    }

    pub fn catalog(&self) -> Option<String> {
        let rows = self
            .selected
            .iter()
            .map(|row| {
                let excerpt: String = row.text.chars().take(CATALOG_CHARS).collect();
                object(vec![
                    ("id", string(row.revision.id.as_str())),
                    ("at", row.revision.at.encode()),
                    ("excerpt", string(&excerpt)),
                ])
            })
            .collect();
        canonical_json(&OrderedValue::array(rows))
    }
}

fn visible_rows<'a>(
    history: Vec<&'a RawValue>,
    current: Candidate<'a>,
    room: &ChatRoomId,
    end: &JournalMessage,
) -> Option<Vec<JournalMessage>> {
    let mut rows = BTreeMap::new();
    for raw in history {
        let value = decode_memory_str(raw.get().as_bytes()).ok()?;
        if field(&value.value, "roomId")
            .and_then(scalar)
            .is_none_or(|id| id != room.as_str())
        {
            continue;
        }
        let Some(encoded_at) = field(&value.value, "at") else {
            continue;
        };
        let at = Timestamp::decode(encoded_at)?;
        if at.compare(&end.revision.at).is_le() {
            let id = scalar(field(&value.value, "id")?)?;
            rows.insert(id, Candidate { at, raw });
        }
    }
    rows.insert(end.revision.id.as_str().to_owned(), current);
    let mut rows: Vec<_> = rows.into_iter().collect();
    rows.sort_unstable_by(|(id, a), (other, b)| a.at.compare(&b.at).then_with(|| id.cmp(other)));
    let start = rows.len().saturating_sub(VISIBLE_LIMIT);
    rows.into_iter()
        .skip(start)
        .map(|(id, candidate)| {
            let id = ChatMessageId::parse(&id).ok()?;
            let value = decode_memory_str(candidate.raw.get().as_bytes()).ok()?;
            JournalMessage::observed(&value, room, &id)
        })
        .collect()
}
