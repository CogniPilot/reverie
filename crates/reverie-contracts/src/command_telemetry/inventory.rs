use super::{Result, TelemetryDataError};
use crate::{
    legacy_json::{self, Node, Text},
    storage_identity::MetadataText,
};
use reverie_core::command_telemetry::TelemetryContainerId;
/// Python str.splitlines(), including its non-ASCII separators and CRLF pair.
/// Listing IDs are checked as a complete batch before the first inspect.
pub fn inventory_ids(output: &str) -> Result<Vec<TelemetryContainerId>> {
    let lines = crate::reservation_engine::splitlines(output);
    if lines.len() > 64 {
        return Err(TelemetryDataError::Inventory);
    }
    lines
        .into_iter()
        .map(|line| TelemetryContainerId::parse(line).map_err(|_| TelemetryDataError::Inventory))
        .collect()
}
/// Full inspect stdout uses default json.loads(str), not strict metadata JSON.
/// Validate ALL mount rows before any canonical filesystem source observation.
pub fn inspect_sources(raw: &str) -> Result<Vec<MetadataText>> {
    let value = legacy_json::decode_python_str(raw.as_bytes())
        .map_err(|_| TelemetryDataError::Inventory)?;
    let Node::Array(rows) = &value.0 else {
        return Err(TelemetryDataError::Inventory);
    };
    if rows.len() != 1 {
        return Err(TelemetryDataError::Inventory);
    }
    let Node::Object(row) = &rows[0].0 else {
        return Err(TelemetryDataError::Inventory);
    };
    let Some(mounts) = row.get(&Text("Mounts".chars().map(u32::from).collect())) else {
        return Err(TelemetryDataError::Inventory);
    };
    let Node::Array(mounts) = &mounts.0 else {
        return Err(TelemetryDataError::Inventory);
    };
    let mut out = Vec::new();
    for mount in mounts {
        let Node::Object(fields) = &mount.0 else {
            return Err(TelemetryDataError::Inventory);
        };
        let kind = fields.get(&Text("Type".chars().map(u32::from).collect()));
        let kind = kind.and_then(|value| {
            if let Node::String(kind) = &value.0 {
                Some(kind)
            } else {
                None
            }
        });
        if kind.is_some_and(|kind| kind.equals_ascii("tmpfs")) {
            continue;
        }
        if !kind.is_some_and(|kind| kind.equals_ascii("bind") || kind.equals_ascii("volume")) {
            return Err(TelemetryDataError::Inventory);
        }
        let Some(source) = fields.get(&Text("Source".chars().map(u32::from).collect())) else {
            return Err(TelemetryDataError::Inventory);
        };
        let Node::String(source) = &source.0 else {
            return Err(TelemetryDataError::Inventory);
        };
        if source.0.is_empty() {
            return Err(TelemetryDataError::Inventory);
        }
        out.push(MetadataText::from_text(source.clone()));
    }
    Ok(out)
}
