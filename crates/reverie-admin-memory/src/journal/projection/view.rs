use super::{
    expression,
    model::{Currentness, Model, Record},
    stripped, wire_size,
};
use crate::office::Office;
use reverie_core::ids::ChatRoomId;
use reverie_store::memory::{JournalReader, MemoryError, PAGE_SIZE, Result};
use serde_json::{Number, Value, json};
use std::collections::{BTreeMap, BTreeSet};

const VIEW_BYTES: usize = 12_000;

pub(crate) struct View<'a> {
    pub(crate) query: &'a str,
    pub(crate) before: Option<i64>,
    pub(crate) snapshot: Option<i64>,
    pub(crate) as_of: Option<&'a Number>,
}

impl View<'_> {
    fn validate(&self) -> Result<Option<f64>> {
        let as_of = self.as_of.and_then(Number::as_f64);
        if self.query.chars().count() > 300
            || self.before.is_some_and(|id| id < 1)
            || self.snapshot.is_some_and(|id| id < 1)
            || self.as_of.is_some() && !as_of.is_some_and(|at| at.is_finite() && at >= 0.0)
        {
            return Err(MemoryError::Integrity);
        }
        Ok(as_of)
    }

    pub(super) fn page(
        &self,
        store: &JournalReader<'_>,
        office: &Office,
        room: &ChatRoomId,
    ) -> Result<Value> {
        let as_of = self.validate()?;
        let top = store.ceiling()?;
        let ceiling = self.snapshot.map_or(top, |id| top.min(id));
        let filter = expression(self.query);
        let rows = if stripped(self.query).is_empty() || filter.is_some() {
            store.page(ceiling, self.before, as_of, filter.as_deref())?
        } else {
            Vec::new()
        };
        let more = rows.len() > usize::from(PAGE_SIZE);
        let examined = rows.len().min(usize::from(PAGE_SIZE));
        let scanned = rows
            .into_iter()
            .take(usize::from(PAGE_SIZE))
            .map(Record::decode)
            .collect::<Result<Vec<_>>>()?;
        let cursor = more.then(
            || json!({"snapshot_id": ceiling, "before_id": scanned.last().map(|row| row.id)}),
        );
        let mut model = Model::new(store, office, room, as_of);
        let entries = model.project(scanned, false)?;
        let view = entries
            .iter()
            .map(|(record, state)| item(record, state))
            .collect::<Vec<_>>();
        let mut result = json!({
            "status": "available", "scope": room.as_str(), "entries": view,
            "cursor": cursor, "as_of_recorded_ms": self.as_of,
            "coverage": {"examined": examined, "returned": view.len(), "more": more,
                         "omitted_or_source_changed": model.omitted,
                         "meaning": "bounded examined page only; no whole-history count"},
        });
        let (tags, edges) = topics(&entries);
        result["tags"] = json!(tags);
        result["edges"] = json!(edges);
        if wire_size(&result).is_none_or(|(bytes, _)| bytes > VIEW_BYTES) {
            return Ok(
                json!({"status": "unavailable", "scope": room.as_str(), "reason": "projection_exceeds_byte_budget"}),
            );
        }
        Ok(result)
    }
}

fn item(record: &Record, state: &Currentness) -> Value {
    let entry = &record.entry;
    let annotations = entry.annotations();
    json!({
        "id": record.id, "recorded_at_ms": record.committed_ms, "occurred_at_ms": entry.occurred_at(),
        "text": entry.draft()["text"], "kinds": entry.draft()["tags"],
        "topics": annotations.get("topics").cloned().unwrap_or(json!([])),
        "importance": annotations["importance"],
        "provenance": annotations.get("provenance").cloned().unwrap_or(json!("unknown")),
        "source_check": "All cited revisions matched in this operation; this does not verify the interpretation",
        "source_ids": entry.source_ids().collect::<Vec<_>>(),
        "currentness": state.label(), "superseded_by": state.superseded_by(),
        "related": annotations.get("related").cloned().unwrap_or(json!([])),
    })
}

fn topics(entries: &[(Record, Currentness)]) -> (Vec<Value>, Vec<Value>) {
    let mut grouped = BTreeMap::<&str, BTreeSet<i64>>::new();
    for (record, _) in entries {
        let topics = record.entry.annotations()["topics"]
            .as_array()
            .into_iter()
            .flatten();
        for topic in topics.filter_map(Value::as_str) {
            grouped.entry(topic).or_default().insert(record.id);
        }
    }
    let tags = grouped
        .iter()
        .map(|(label, ids)| json!({"label": label, "count": ids.len(), "entry_ids": ids}))
        .collect();
    (tags, edges(&grouped))
}

fn edges(grouped: &BTreeMap<&str, BTreeSet<i64>>) -> Vec<Value> {
    let mut result = Vec::new();
    for (&a, entries) in grouped {
        use std::ops::Bound::{Excluded, Unbounded};
        for (&b, others) in grouped.range::<&str, _>((Excluded(a), Unbounded)) {
            let ids = entries.intersection(others).copied().collect::<Vec<_>>();
            if !ids.is_empty() {
                result.push(json!({"a": a, "b": b, "entry_ids": ids, "count": ids.len()}));
            }
        }
    }
    result
}
