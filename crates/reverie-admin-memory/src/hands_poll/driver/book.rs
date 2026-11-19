//! Preserve existing JSON key order and publish each claim before its effects.
use super::Link;
use crate::{
    TURN_CAPTURE_BOUND,
    hands_poll::{file, rooms::Selection, state::Room},
    refused,
};
use indexmap::IndexMap;
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};
use std::{io, path::PathBuf};

pub(super) type State = IndexMap<String, Box<RawValue>>;

pub(super) struct Book {
    path: PathBuf,
    state: State,
}

impl Book {
    pub(super) fn new(path: PathBuf, state: State) -> Self {
        Self { path, state }
    }

    pub(super) fn value(&self, key: &str) -> Value {
        self.state
            .get(key)
            .and_then(|raw| serde_json::from_str(raw.get()).ok())
            .unwrap_or_default()
    }

    pub(super) fn room(&self, id: &str) -> io::Result<Room> {
        let room = self.state.get(id).map_or("{}", |raw| raw.get());
        Ok(serde_json::from_str(room)?)
    }

    pub(super) fn update_room(&mut self, id: &str, room: &Room, link: &mut Link) -> io::Result<()> {
        self.publish(&[(id, serde_json::to_value(room)?)], &[], link)
    }

    pub(super) fn listing(&mut self, listing: &Selection<'_>, link: &mut Link) -> io::Result<()> {
        let ids = listing
            .rooms
            .iter()
            .map(|record| record.id)
            .collect::<Vec<_>>();
        let dms = listing
            .rooms
            .iter()
            .filter(|record| record.direct)
            .map(|record| record.id)
            .collect::<Vec<_>>();
        self.publish(
            &[("_auto_rooms", json!(ids)), ("_auto_dms", json!(dms))],
            &listing.joined,
            link,
        )
    }

    pub(super) fn coding(&mut self, mut updates: State) {
        for key in ["_coding", "_coding_epoch"] {
            if let Some(raw) = updates.shift_remove(key) {
                self.state.insert(key.to_owned(), raw);
            } else {
                self.state.shift_remove(key);
            }
        }
    }

    pub(super) fn complete_left(
        &mut self,
        id: &str,
        room: &Room,
        link: &mut Link,
    ) -> io::Result<()> {
        let mut active = self
            .value("_auto_rooms")
            .as_array()
            .cloned()
            .unwrap_or_default();
        active.retain(|room| room.as_str() != Some(id));
        self.publish(
            &[
                ("_auto_rooms", json!(active)),
                (id, serde_json::to_value(room)?),
            ],
            &[],
            link,
        )
    }

    fn publish(
        &mut self,
        patch: &[(&str, Value)],
        remove: &[&str],
        link: &mut Link,
    ) -> io::Result<()> {
        for id in remove {
            self.state.shift_remove(*id);
        }
        for (key, value) in patch {
            self.state.insert((*key).to_owned(), to_raw_value(value)?);
        }
        let bytes = serde_json::to_vec(&self.state)?;
        if bytes.len() > TURN_CAPTURE_BOUND - 128 {
            return Err(refused());
        }
        file::save(&self.path, &bytes)?;
        link.tell(json!({"state":{"set":patch,"remove":remove}}))
    }
}
