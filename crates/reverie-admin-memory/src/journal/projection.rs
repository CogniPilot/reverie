use crate::{database::Database, office::Office, refused};
use reverie_contracts::memory::channel::journal::canonical_journal_output;
use reverie_core::{ids::ChatRoomId, python_regex};
use reverie_store::memory::{JournalReader, NativeMemoryRead, Result};
use serde_json::{
    Value, json,
    value::{self, RawValue},
};
use std::io;

mod model;
mod recall;
mod view;
pub(crate) use view::View;

pub(crate) enum Projection<'a> {
    Status(Option<&'a str>),
    Recall(&'a str),
    View(View<'a>),
}

impl Projection<'_> {
    pub(crate) fn execute(
        &self,
        office: &Office,
        room: &ChatRoomId,
        database: &Database,
    ) -> io::Result<Box<RawValue>> {
        office.require_membership(room)?;
        let path = database.existing_file()?;
        let result = NativeMemoryRead::read_journal(path, |store| match self {
            Self::Status(query) => status(store, office, room, *query),
            Self::Recall(query) => recall::recall(store, office, room, query, false),
            Self::View(view) => view.page(store, office, room),
        })
        .map_err(|_| refused())?;
        office.require_membership(room)?;
        Ok(value::to_raw_value(&result)?)
    }
}

fn status(
    store: &JournalReader<'_>,
    office: &Office,
    room: &ChatRoomId,
    query: Option<&str>,
) -> Result<Value> {
    let checkpoint = store.checkpoint()?.map(|checkpoint| {
        json!({
            "id": checkpoint.id, "turn_id": checkpoint.turn_id,
            "committed_ms": checkpoint.committed_ms, "end_at": checkpoint.end_at,
        })
    });
    let mut result = json!({"status": "available", "checkpoint": checkpoint});
    if let Some(query) = query {
        result["recall"] = recall::recall(store, office, room, query, true).unwrap_or_else(|_| {
            json!({
                "status": "unavailable", "scope": room.as_str(), "entries": [],
                "omitted_or_source_changed": true,
            })
        });
    }
    Ok(result)
}

fn stripped(query: &str) -> &str {
    query.trim_matches(|ch: char| python_regex::space(ch.into()))
}

fn expression(query: &str) -> Option<String> {
    let items = query
        .split(|ch: char| ch == '_' || !python_regex::word(ch.into()))
        .filter(|token| !token.is_empty())
        .take(12)
        .map(|token| format!("\"{token}\""))
        .collect::<Vec<_>>();
    (!items.is_empty()).then(|| items.join(" OR "))
}

fn wire_size(value: &Value) -> Option<(usize, usize)> {
    let text = canonical_journal_output(value)?;
    Some((text.len(), text.chars().count()))
}
