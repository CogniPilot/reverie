use super::model::{Model, Record};
use super::{expression, stripped, wire_size};
use crate::office::Office;
use reverie_core::ids::ChatRoomId;
use reverie_store::memory::{JournalReader, MemoryError, Result};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

const DAY_MS: f64 = 86_400_000.0;
const CAPSULE_BYTES: usize = 1_536;
const DETAIL_CHARS: usize = 2_200;

pub(super) fn recall(
    store: &JournalReader<'_>,
    office: &Office,
    room: &ChatRoomId,
    query: &str,
    compact: bool,
) -> Result<Value> {
    let count = stripped(query).chars().count();
    if !(1..=300).contains(&count) {
        return Err(MemoryError::Integrity);
    }
    let records = if let Some(expression) = expression(query) {
        ranked(store, &expression)?
    } else {
        Vec::new()
    };
    let mut model = Model::new(store, office, room, None);
    let selected = model.project(records, true)?;
    let mut entries = Vec::new();
    for (record, _) in selected {
        entries.push(item(&record, compact));
        if !fits(room, &entries, compact) {
            model.omitted = true;
            entries.pop();
        }
    }
    Ok(available(
        room,
        Value::Array(entries),
        model.omitted,
        compact,
    ))
}

fn ranked(store: &JournalReader<'_>, expression: &str) -> Result<Vec<Record>> {
    let rows = store.recall_candidates(expression)?;
    let max = rows.iter().map(|(_, rank)| -rank).fold(0.0_f64, f64::max);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| MemoryError::Integrity)?
        .as_secs_f64()
        * 1000.0;
    let mut scored = Vec::with_capacity(rows.len());
    for (row, rank) in rows {
        let record = Record::decode(row)?;
        let relevance = if max > 0.0 {
            (-rank).max(0.0) / max
        } else {
            0.0
        };
        let recency = 0.5_f64.powf((now - record.committed_ms).max(0.0) / DAY_MS / 7.0);
        let score = relevance + recency + record.entry.importance_weight();
        scored.push((record, score));
    }
    scored.sort_by(|(a, score_a), (b, score_b)| {
        score_b.total_cmp(score_a).then_with(|| b.id.cmp(&a.id))
    });
    Ok(scored
        .into_iter()
        .take(2)
        .map(|(record, _)| record)
        .collect())
}

fn available(room: &ChatRoomId, entries: Value, omitted: bool, compact: bool) -> Value {
    let mut result =
        json!({"status": "available", "entries": entries, "omitted_or_source_changed": omitted});
    if compact {
        result["scope"] = json!(room.as_str());
    }
    result
}

fn fits(room: &ChatRoomId, entries: &[Value], compact: bool) -> bool {
    let value = if compact {
        available(room, json!(entries), false, true)
    } else {
        json!(entries)
    };
    wire_size(&value).is_some_and(|(bytes, chars)| {
        if compact {
            bytes <= CAPSULE_BYTES
        } else {
            chars <= DETAIL_CHARS
        }
    })
}

fn item(record: &Record, compact: bool) -> Value {
    let entry = &record.entry;
    let annotations = entry.annotations();
    let mut value = if compact {
        json!({"text": entry.draft()["text"], "tags": entry.draft()["tags"]})
    } else {
        entry.draft().clone()
    };
    value["entry_id"] = json!(record.id);
    value["committed_ms"] = json!(record.committed_ms);
    value["source_ids"] = json!(entry.source_ids().collect::<Vec<_>>());
    value["provenance"] = annotations
        .get("provenance")
        .cloned()
        .unwrap_or(json!("unknown"));
    value["supersedes"] = annotations.get("supersedes").cloned().unwrap_or(json!([]));
    value["related"] = annotations.get("related").cloned().unwrap_or(json!([]));
    if !compact {
        value["evidence"] = json!("source revisions checked; interpretation not verified");
    }
    value
}
