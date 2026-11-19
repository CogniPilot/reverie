//! Closed identity checks for the offline Docker metadata responses.
use super::{QualificationError, Result, require, store_path};
use crate::{
    kernel_accounting::{strip, words},
    legacy_json::{Node, Text, Value, decode_strict_bytes},
    worker_image_switch::WorkerImageId,
};
use reverie_core::ids::ContainerId;
use std::collections::BTreeSet;

pub fn identity(raw: &[u8]) -> Result<String> {
    let unavailable = QualificationError("engine identity unavailable");
    let value = decode_strict_bytes(raw).map_err(|_| unavailable)?;
    let Node::String(text) = &value.0 else {
        return Err(unavailable);
    };
    let text: String = text
        .0
        .iter()
        .map(|&value| char::from_u32(value))
        .collect::<Option<_>>()
        .ok_or(unavailable)?;
    Ok(strip(&text).to_owned())
}

pub fn inventory_ids(raw: &[u8]) -> Result<Vec<String>> {
    let unavailable = QualificationError("container inventory unavailable");
    let items = std::str::from_utf8(raw).map_err(|_| unavailable)?;
    let mut seen = BTreeSet::new();
    let words = words(items);
    require(words.len() <= 256, unavailable.0)?;
    for &id in &words {
        require(
            ContainerId::parse(id).is_ok() && seen.insert(id),
            unavailable.0,
        )?;
    }
    Ok(words.into_iter().map(str::to_owned).collect())
}

pub fn check_image(raw: &[u8], image: &WorkerImageId) -> Result<()> {
    let unavailable = QualificationError("exact loaded image unavailable");
    let array = decode_strict_bytes(raw).map_err(|_| unavailable)?;
    let Node::Array(rows) = &array.0 else {
        return Err(unavailable);
    };
    require(
        matches!(rows.as_slice(), [row] if has_id(row, image.as_str())),
        unavailable.0,
    )
}

pub fn check_batch(raw: &[u8], ids: &[ContainerId]) -> Result<()> {
    let changed = QualificationError("container inventory changed");
    let array = decode_strict_bytes(raw).map_err(|_| changed)?;
    let Node::Array(rows) = &array.0 else {
        return Err(changed);
    };
    require(rows.len() == ids.len(), changed.0)?;
    for id in ids {
        require(
            rows.iter().filter(|row| has_id(row, id.as_str())).count() == 1,
            changed.0,
        )?;
    }
    Ok(())
}

pub fn check_base_target(target: &str) -> Result<()> {
    require(store_path(target), "image base must be an immutable link")
}

fn has_id(row: &Value, id: &str) -> bool {
    let Node::Object(fields) = &row.0 else {
        return false;
    };
    let key = Text(vec![u32::from(b'I'), u32::from(b'd')]);
    matches!(fields.get(&key), Some(Value(Node::String(value))) if value.equals_ascii(id))
}
