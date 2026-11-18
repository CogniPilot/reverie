use crate::hands_settings::truthy;
use reverie_core::ids::ChatRoomId;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

#[derive(Serialize)]
struct ListedRoom<'a> {
    id: &'a str,
    name: &'a str,
    direct: bool,
    latest: Option<&'a str>,
    read: bool,
}

pub(super) fn reconcile(listed: &[Value], state: &Map<String, Value>, cap: usize) -> Value {
    let eligible: Vec<_> = listed
        .iter()
        .filter_map(|row| listed_room(row, state))
        .collect();
    let total = eligible.len();
    let mut selected: Vec<_> = eligible.into_iter().take(cap).collect();
    let current: BTreeSet<_> = selected.iter().map(|room| room.id).collect();
    let before = state
        .get("_auto_rooms")
        .and_then(Value::as_array)
        .map(Vec::as_slice);
    let (joined, left) = changes(&current, before);
    for room in &mut selected {
        room.read |= joined.contains(&room.id);
    }
    json!({ "rooms": selected, "total": total, "joined": joined, "left": left })
}

fn listed_room<'a>(row: &'a Value, state: &Map<String, Value>) -> Option<ListedRoom<'a>> {
    let id = row["id"].as_str()?;
    ChatRoomId::parse(id).ok()?;
    let latest = row["lastMessage"]["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.chars().count() <= 200);
    let read = state.get(id).is_none_or(|saved| {
        latest.is_none()
            || saved["since"].is_null()
            || truthy(&saved["claims"])
            || latest != saved["last_id"].as_str()
    });
    Some(ListedRoom {
        id,
        name: row["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .unwrap_or(id),
        direct: row["kind"].as_str() == Some("dm"),
        latest,
        read,
    })
}

fn changes<'a>(current: &BTreeSet<&'a str>, before: Option<&[Value]>) -> (Vec<&'a str>, usize) {
    let Some(before) = before else {
        return (Vec::new(), 0);
    };
    let before: BTreeSet<_> = before.iter().filter_map(Value::as_str).collect();
    let joined = current
        .iter()
        .copied()
        .filter(|id| !before.contains(id))
        .collect();
    let left = before.difference(current).count();
    (joined, left)
}
