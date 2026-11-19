use super::{SourceRevision, canonical_json, draft::Draft};
use crate::legacy_json::decode_memory_str;
use reverie_core::ids::{ChatMessageId, ChatRoomId};
use serde::Deserialize;
use serde_json::{Value, value::RawValue};
use std::collections::BTreeMap;

/// An existing journal payload and the recorded revisions of its cited sources.
pub struct JournalEntry {
    draft: Value,
    occurred_at: Value,
    evidence: Option<Evidence>,
}

struct Evidence {
    room: ChatRoomId,
    sources: Vec<SourceRevision>,
}

#[derive(Deserialize)]
struct Payload<'a> {
    #[serde(borrow)]
    draft: &'a RawValue,
    #[serde(borrow)]
    snapshot: &'a RawValue,
}

impl JournalEntry {
    pub fn decode(payload: &str) -> Option<Self> {
        let payload: Payload<'_> = serde_json::from_str(payload).ok()?;
        let draft = Draft::decode(payload.draft.get())?;
        let snapshot: Value = serde_json::from_str(payload.snapshot.get()).ok()?;
        Some(Self {
            draft: serde_json::from_str(payload.draft.get()).ok()?,
            occurred_at: snapshot["end"]["at"].clone(),
            evidence: Evidence::decode(&draft, &snapshot),
        })
    }

    pub fn draft(&self) -> &Value {
        &self.draft
    }

    pub fn occurred_at(&self) -> &Value {
        &self.occurred_at
    }

    pub fn cited_revisions(&self, room: &ChatRoomId) -> Option<&[SourceRevision]> {
        let evidence = self.evidence.as_ref()?;
        (&evidence.room == room).then_some(evidence.sources.as_slice())
    }

    pub fn annotations(&self) -> &Value {
        &self.draft["annotations"]
    }

    pub fn supersedes(&self) -> impl Iterator<Item = i64> + '_ {
        self.annotations()["supersedes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_i64)
    }

    pub fn source_ids(&self) -> impl Iterator<Item = &str> {
        self.draft["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|source| source["id"].as_str())
    }

    pub fn importance_weight(&self) -> f64 {
        match self.annotations()["importance"].as_str() {
            Some("notable") => 1.0 / 3.0,
            Some("important") => 2.0 / 3.0,
            Some("keystone") => 1.0,
            _ => 0.0,
        }
    }
}

impl Evidence {
    fn decode(draft: &Draft, snapshot: &Value) -> Option<Self> {
        let room = ChatRoomId::parse(snapshot["room"].as_str()?).ok()?;
        let events = snapshot["events"].as_array()?;
        let mut revisions = events
            .iter()
            .filter_map(|event| {
                let id = ChatMessageId::parse(event["id"].as_str()?).ok()?;
                let revision = SourceRevision::decode(event.to_string().as_bytes());
                Some((id, revision))
            })
            .collect::<BTreeMap<_, _>>();
        let sources = draft
            .sources
            .iter()
            .map(|quote| {
                let id = ChatMessageId::parse(&quote.id).ok()?;
                revisions.remove(&id).flatten()
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self { room, sources })
    }
}

/// The journal's existing compact JSON chooses Python-compatible float spelling and Unicode.
pub fn canonical_journal_output(value: &Value) -> Option<String> {
    canonical_json(&decode_memory_str(value.to_string().as_bytes()).ok()?)
}
