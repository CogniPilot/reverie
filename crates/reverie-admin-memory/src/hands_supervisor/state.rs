use crate::hands_poll;
use indexmap::IndexMap;
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};
use std::{io, path::Path};

pub(super) type Ordered = IndexMap<String, Box<RawValue>>;

pub(super) fn load(path: &Path) -> io::Result<Box<RawValue>> {
    Ok(hands_poll::load_state(path)?
        .value
        .unwrap_or(to_raw_value(&json!({}))?))
}

pub(super) fn ordered(path: &Path) -> io::Result<Ordered> {
    Ok(serde_json::from_str(load(path)?.get())?)
}

pub(super) fn save(path: &Path, state: &Ordered) -> io::Result<()> {
    let bytes = serde_json::to_vec(state)?;
    if bytes.len() > crate::TURN_CAPTURE_BOUND - 128 {
        return Err(crate::refused());
    }
    hands_poll::save_state(path, &bytes)
}

pub(super) fn recover(path: &Path) -> io::Result<()> {
    let mut state = ordered(path)?;
    let Some(raw) = state.get_mut("_coding") else {
        return Ok(());
    };
    let mut journal: Ordered = serde_json::from_str(raw.get())?;
    let mut changed = false;
    for row in journal.values_mut() {
        let mut value: Value = serde_json::from_str(row.get())?;
        if value["status"] == "started" {
            value["status"] = json!("stopped");
            value["reason"] = json!("interrupted");
            *row = to_raw_value(&value)?;
            changed = true;
        }
    }
    if changed {
        *raw = to_raw_value(&journal)?;
        save(path, &state)?;
    }
    Ok(())
}
