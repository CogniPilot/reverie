use super::EXCERPT_BYTES;
use serde::{Deserialize, Deserializer};
use std::collections::BTreeSet;

pub const JOURNAL_TAGS: &[&str] = &[
    "decision",
    "promise",
    "correction",
    "preference",
    "identity",
    "relationship",
    "open-question",
    "lesson",
    "personal-reflection",
];
pub const JOURNAL_TOPICS: &[&str] = &[
    "Shared history",
    "People",
    "Work",
    "Memory and harness",
    "Games and play",
    "Identity",
    "Other",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Quote {
    pub(super) id: String,
    pub(super) quote: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Draft {
    text: String,
    tags: Vec<String>,
    pub(super) sources: Vec<Quote>,
    #[serde(default, deserialize_with = "present")]
    annotations: Option<Annotations>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Annotations {
    #[serde(default, deserialize_with = "present")]
    topics: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    importance: Option<Importance>,
    #[serde(default, deserialize_with = "present")]
    provenance: Option<Provenance>,
    #[serde(default, deserialize_with = "present")]
    supersedes: Option<Vec<i64>>,
    #[serde(default, deserialize_with = "present")]
    related: Option<Vec<i64>>,
    #[serde(default, deserialize_with = "present")]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Importance {
    Notable,
    Important,
    Keystone,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Provenance {
    Direct,
    Relayed,
    Reconstructed,
    Unknown,
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl Draft {
    pub(super) fn decode(raw: &str) -> Option<Self> {
        let draft: Self = serde_json::from_str(raw).ok()?;
        draft.valid().then_some(draft)
    }

    fn valid(&self) -> bool {
        bounded_text(&self.text, EXCERPT_BYTES)
            && selected(&self.tags, JOURNAL_TAGS)
            && distinct(self.sources.iter().map(|source| source.id.as_str()), 4)
            && self
                .sources
                .iter()
                .all(|source| bounded_text(&source.quote, 256))
            && self.annotations.as_ref().is_none_or(|annotations| {
                annotations.valid(self.tags.iter().any(|tag| tag == "correction"))
            })
    }

    pub(super) fn index_text(&self) -> String {
        let mut parts = vec![self.text.as_str()];
        parts.extend(self.tags.iter().map(String::as_str));
        parts.extend(self.sources.iter().map(|source| source.quote.as_str()));
        if let Some(topics) = self
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.topics.as_ref())
        {
            parts.extend(topics.iter().map(String::as_str));
        }
        parts.join(" ")
    }

    pub(super) fn supersedes(&self) -> &[i64] {
        self.annotations
            .as_ref()
            .and_then(|annotations| annotations.supersedes.as_deref())
            .unwrap_or_default()
    }

    pub(super) fn related(&self) -> &[i64] {
        self.annotations
            .as_ref()
            .and_then(|annotations| annotations.related.as_deref())
            .unwrap_or_default()
    }
}

impl Annotations {
    fn valid(&self, correction: bool) -> bool {
        self.has_fields()
            && self
                .topics
                .as_ref()
                .is_none_or(|values| selected(values, JOURNAL_TOPICS))
            && self
                .supersedes
                .as_ref()
                .is_none_or(|values| correction && prior_ids(values))
            && self.related.as_ref().is_none_or(|values| prior_ids(values))
            && self
                .reason
                .as_ref()
                .is_none_or(|reason| bounded_text(reason, 200))
    }

    fn has_fields(&self) -> bool {
        self.topics.is_some()
            || self.importance.is_some()
            || self.provenance.is_some()
            || self.supersedes.is_some()
            || self.related.is_some()
            || self.reason.is_some()
    }
}

pub(super) fn selected(values: &[String], allowed: &[&str]) -> bool {
    distinct(values.iter().map(String::as_str), 6)
        && values.iter().all(|value| allowed.contains(&value.as_str()))
}

fn prior_ids(values: &[i64]) -> bool {
    distinct(values.iter().copied(), 4) && values.iter().all(|value| *value > 0)
}

pub(super) fn distinct<I: ExactSizeIterator<Item: Ord>>(items: I, max: usize) -> bool {
    let count = items.len();
    (1..=max).contains(&count) && items.collect::<BTreeSet<_>>().len() == count
}

pub(super) fn bounded_text(value: &str, max: usize) -> bool {
    value.len() <= max
        && !value
            .trim_matches(|ch: char| ch.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&ch))
            .is_empty()
}
