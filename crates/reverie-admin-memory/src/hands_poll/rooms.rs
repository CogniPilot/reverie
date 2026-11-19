use crate::hands_settings::truthy;
use reverie_core::ids::ChatRoomId;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Serialize)]
pub(super) struct ListedRoom<'a> {
    pub(super) id: &'a str,
    pub(super) name: &'a str,
    pub(super) direct: bool,
    pub(super) latest: Option<&'a str>,
    pub(super) read: bool,
}

#[derive(Serialize)]
pub(super) struct Selection<'a> {
    pub(super) rooms: Vec<ListedRoom<'a>>,
    pub(super) total: usize,
    pub(super) joined: Vec<&'a str>,
    pub(super) left: usize,
}

pub(super) fn reconcile<'a>(
    listed: &'a [Value],
    before: Option<&[Value]>,
    saved: impl Fn(&str) -> Value,
    cap: usize,
) -> Selection<'a> {
    let eligible: Vec<_> = listed
        .iter()
        .filter_map(|row| listed_room(row, &saved))
        .collect();
    let total = eligible.len();
    let mut selected: Vec<_> = eligible.into_iter().take(cap).collect();
    let current: BTreeSet<_> = selected.iter().map(|room| room.id).collect();
    let (joined, left) = changes(&current, before);
    for room in &mut selected {
        room.read |= joined.contains(&room.id);
    }
    Selection {
        rooms: selected,
        total,
        joined,
        left,
    }
}

fn listed_room<'a>(row: &'a Value, saved: &impl Fn(&str) -> Value) -> Option<ListedRoom<'a>> {
    let id = row["id"].as_str()?;
    ChatRoomId::parse(id).ok()?;
    let latest = row["lastMessage"]["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.chars().count() <= 200);
    let saved = saved(id);
    let read = latest.is_none()
        || saved["since"].is_null()
        || truthy(&saved["claims"])
        || latest != saved["last_id"].as_str();
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
