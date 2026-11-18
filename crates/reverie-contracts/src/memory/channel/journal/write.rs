use super::draft::Draft;
use super::{JournalMessage, SourceRevision, Timestamp, canonical_json, journal_digest};
use crate::{
    legacy_json::{Number, decode_memory_str},
    memory::{object, string},
};
use reverie_core::{
    ids::{ChatMessageId, ChatRoomId},
    operations::JournalDigest,
};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::collections::BTreeMap;

const CLASSIFICATION: &str = "source-linked agent account; interpretation is not verified fact";

#[derive(Clone, Copy, Deserialize)]
enum Coverage {
    #[serde(rename = "bounded-visible-messages; gaps are not claimed covered")]
    Visible,
    #[serde(rename = "bounded-visible-and-exact-sources; gaps are not claimed covered")]
    Expanded,
}

impl Coverage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Visible => "bounded-visible-messages; gaps are not claimed covered",
            Self::Expanded => "bounded-visible-and-exact-sources; gaps are not claimed covered",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture<'a> {
    room: &'a str,
    #[serde(borrow)]
    end: &'a RawValue,
    #[serde(borrow)]
    events: Vec<&'a RawValue>,
    coverage: Coverage,
}

struct Evidence {
    revision: SourceRevision,
    quote: Option<String>,
}

pub struct SourceCheck<'a>(&'a Evidence);

impl SourceCheck<'_> {
    pub fn id(&self) -> &ChatMessageId {
        self.0.revision.id()
    }

    pub fn refusal(&self, message: &JournalMessage) -> Option<&'static str> {
        if !message.matches(&self.0.revision) {
            return Some("source_changed");
        }
        self.0
            .quote
            .as_ref()
            .filter(|quote| !message.text.contains(quote.as_str()))
            .map(|_| "quote_not_in_source")
    }
}

/// Validated commit data. The caller still verifies the live sources and membership.
pub struct JournalCommit {
    end: ChatMessageId,
    checks: BTreeMap<ChatMessageId, Evidence>,
    end_at: f64,
    coverage: Coverage,
    payload: String,
    digest: JournalDigest,
    index_text: String,
    supersedes: Vec<i64>,
    related: Vec<i64>,
}

impl JournalCommit {
    pub fn decode(draft: &RawValue, captured: &RawValue, room: &ChatRoomId) -> Option<Self> {
        let plan = Draft::decode(draft.get())?;
        let capture: Capture<'_> = serde_json::from_str(captured.get()).ok()?;
        if capture.room != room.as_str() || !(1..=14).contains(&capture.events.len()) {
            return None;
        }
        let end = revision(capture.end)?;
        let end_at = storage_time(&end.at)?;
        let end_id = end.id.clone();
        let checks = review(&plan, capture.events, end)?;
        let payload = canonical_json(&object(vec![
            ("classification", string(CLASSIFICATION)),
            ("draft", decode_memory_str(draft.get().as_bytes()).ok()?),
            (
                "snapshot",
                decode_memory_str(captured.get().as_bytes()).ok()?,
            ),
        ]))?;
        Some(Self {
            end: end_id,
            checks,
            end_at,
            coverage: capture.coverage,
            digest: journal_digest(&payload),
            payload,
            index_text: plan.index_text(),
            supersedes: plan.supersedes().to_vec(),
            related: plan.related().to_vec(),
        })
    }

    pub fn sources(&self) -> impl Iterator<Item = SourceCheck<'_>> {
        self.checks.values().map(SourceCheck)
    }

    pub fn turn_id(&self) -> &ChatMessageId {
        &self.end
    }

    pub fn end_at(&self) -> f64 {
        self.end_at
    }

    pub fn follows(&self, at: f64, turn: &str) -> bool {
        at.is_finite()
            && at >= 0.0
            && self
                .end_revision()
                .at
                .compare(&Timestamp(Number::Float(at)))
                .then_with(|| self.end.as_str().cmp(turn))
                .is_gt()
    }

    pub fn covers_target(&self, at: f64) -> bool {
        at.is_finite()
            && at >= 0.0
            && self
                .end_revision()
                .at
                .compare(&Timestamp(Number::Float(at)))
                .is_ge()
    }

    fn end_revision(&self) -> &SourceRevision {
        &self.checks[&self.end].revision
    }

    pub fn coverage(&self) -> &'static str {
        self.coverage.as_str()
    }

    pub fn payload(&self) -> &str {
        &self.payload
    }

    pub fn digest(&self) -> &JournalDigest {
        &self.digest
    }

    pub fn index_text(&self) -> &str {
        &self.index_text
    }

    pub fn supersedes(&self) -> &[i64] {
        &self.supersedes
    }

    pub fn targets(&self) -> impl Iterator<Item = i64> + '_ {
        self.supersedes.iter().chain(&self.related).copied()
    }
}

fn revision(raw: &RawValue) -> Option<SourceRevision> {
    SourceRevision::decode(raw.get().as_bytes())
}

fn review(
    plan: &Draft,
    captured: Vec<&RawValue>,
    end: SourceRevision,
) -> Option<BTreeMap<ChatMessageId, Evidence>> {
    let mut events = revisions(captured, &end)?;
    let end_id = end.id.clone();
    let mut checks = BTreeMap::new();
    for source in &plan.sources {
        let id = ChatMessageId::parse(&source.id).ok()?;
        let revision = events.remove(&id)?;
        checks.insert(
            id,
            Evidence {
                revision,
                quote: Some(source.quote.clone()),
            },
        );
    }
    if let Some(evidence) = checks.get_mut(&end_id) {
        evidence.revision = end;
    } else {
        checks.insert(
            end_id,
            Evidence {
                revision: end,
                quote: None,
            },
        );
    }
    Some(checks)
}

fn revisions(
    captured: Vec<&RawValue>,
    end: &SourceRevision,
) -> Option<BTreeMap<ChatMessageId, SourceRevision>> {
    let mut events = BTreeMap::new();
    for raw in captured {
        let event = revision(raw)?;
        if event.at.compare(&end.at).is_gt()
            || event.id == end.id
                && (event.sha256 != end.sha256 || !event.at.compare(&end.at).is_eq())
            || events.insert(event.id.clone(), event).is_some()
        {
            return None;
        }
    }
    Some(events)
}

fn storage_time(at: &Timestamp) -> Option<f64> {
    match &at.0 {
        Number::Integer(value) => Some(value.parse::<i64>().ok()? as f64),
        Number::Float(value) => Some(*value),
        _ => None,
    }
}
