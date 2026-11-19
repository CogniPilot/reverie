mod sqlite;

use super::{Result, policy::Chat, storage};
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::memory::trim_text;
use reverie_host::memory_screen::MemoryScreen;
use serde_json::Value;
use std::{collections::BTreeSet, path::Path};

const CONTEXT_MESSAGES: usize = 3;
const CONTEXT_CHARS: usize = 1500;
const REPLY_CHARS: usize = 4000;
const LOOKBACK: usize = 12;

pub(super) struct Episode {
    pub(super) source: String,
    pub(super) at: f64,
    pub(super) user: String,
    pub(super) reply: String,
}

pub(super) enum Rooms<'a> {
    Json(Vec<Value>),
    Database(&'a Path),
}

impl<'a> Rooms<'a> {
    pub(super) fn load(chat: &'a Chat) -> Result<Self> {
        match chat {
            Chat::Json(path) => {
                let mut rooms: Value = serde_json::from_reader(storage::read_snapshot(path)?)?;
                if let Some(value) = rooms
                    .as_object_mut()
                    .and_then(|object| object.remove("rooms"))
                {
                    rooms = value;
                }
                let values = match rooms {
                    Value::Array(values) => values,
                    Value::Object(values) => values.into_values().collect(),
                    _ => return Err("invalid chat rooms".into()),
                };
                Ok(Self::Json(values))
            }
            Chat::Database(path) => Ok(Self::Database(path)),
        }
    }

    pub(super) fn episodes(
        &self,
        ids: &BTreeSet<String>,
        since: f64,
        screen: &MemoryScreen,
    ) -> Result<Vec<Episode>> {
        let database;
        let rooms = match self {
            Self::Json(values) => values,
            Self::Database(path) => {
                database = sqlite::load(path, ids, since)?;
                &database
            }
        };
        let mut episodes = Vec::new();
        for room in rooms.iter().filter(|room| member_room(room, ids)) {
            collect(room, ids, since, screen, &mut episodes)?;
        }
        episodes.sort_by(|left, right| left.at.total_cmp(&right.at));
        Ok(episodes)
    }
}

fn enabled(field: Option<&Value>) -> bool {
    match field {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(value)) => value.as_f64() != Some(0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(value)) => !value.is_empty(),
        Some(Value::Object(value)) => !value.is_empty(),
        Some(Value::Bool(true)) => true,
    }
}

fn member_room(room: &Value, ids: &BTreeSet<String>) -> bool {
    !enabled(room.get("dm"))
        && room
            .get("members")
            .and_then(Value::as_array)
            .is_some_and(|members| {
                members.iter().any(|member| {
                    member
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| ids.contains(id))
                })
            })
}

fn own_message(message: &Value, ids: &BTreeSet<String>) -> bool {
    message
        .get("from")
        .and_then(|from| from.get("sessionId"))
        .and_then(Value::as_str)
        .is_some_and(|id| ids.contains(id))
}

fn collect(
    room: &Value,
    ids: &BTreeSet<String>,
    since: f64,
    screen: &MemoryScreen,
    episodes: &mut Vec<Episode>,
) -> Result<()> {
    let Some(messages) = room.get("messages").and_then(Value::as_array) else {
        return Ok(());
    };
    let messages = messages
        .iter()
        .filter(|message| message.is_object() && !enabled(message.get("deleted")))
        .collect::<Vec<_>>();
    let name = text(room, "name")
        .filter(|value| !value.is_empty())
        .unwrap_or("room");
    for (index, message) in messages.iter().enumerate() {
        if !own_message(message, ids) {
            continue;
        }
        let at = sent_at(message)?;
        let reply = trim_text(text(message, "text").unwrap_or_default());
        if at <= since || reply.is_empty() {
            continue;
        }
        let Some(id) = text(message, "id").filter(|value| !value.is_empty()) else {
            continue;
        };
        let before = &messages[index.saturating_sub(LOOKBACK)..index];
        let user = context(name, before, ids, screen)?;
        episodes.push(Episode {
            source: format!("room:{id}"),
            at,
            user,
            reply: reply.chars().take(REPLY_CHARS).collect(),
        });
    }
    Ok(())
}

fn sent_at(message: &Value) -> Result<f64> {
    let Some(raw) = message.get("at") else {
        return Ok(0.0);
    };
    raw.as_f64()
        .or_else(|| raw.as_str()?.parse().ok())
        .filter(|at| at.is_finite())
        .ok_or_else(|| "invalid chat timestamp".into())
}

fn context(
    name: &str,
    before: &[&Value],
    ids: &BTreeSet<String>,
    screen: &MemoryScreen,
) -> Result<String> {
    let other: Vec<_> = before
        .iter()
        .filter(|message| !own_message(message, ids))
        .collect();
    let bodies: Vec<_> = other
        .iter()
        .map(|message| MetadataText::from_scalar_text(text(message, "text").unwrap_or_default()))
        .collect();
    let allowed: Vec<_> = other
        .into_iter()
        .zip(screen.check_many(&bodies)?)
        .filter_map(|(message, reason)| reason.is_empty().then_some(message))
        .collect();
    let records = allowed
        .into_iter()
        .rev()
        .take(CONTEXT_MESSAGES)
        .collect::<Vec<_>>();
    let mut context = format!("[{name}]\n");
    for (i, message) in records.into_iter().rev().enumerate() {
        if i > 0 {
            context.push('\n');
        }
        let from = &message["from"];
        let speaker = if text(from, "kind") == Some("user") {
            "Owner"
        } else {
            text(from, "name")
                .filter(|value| !value.is_empty())
                .unwrap_or("member")
        };
        context.push_str(speaker);
        context.push_str(": ");
        context.push_str(text(message, "text").unwrap_or_default());
    }
    let skip = context.chars().count().saturating_sub(CONTEXT_CHARS);
    Ok(context.chars().skip(skip).collect())
}

fn text<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    object.get(key)?.as_str()
}
