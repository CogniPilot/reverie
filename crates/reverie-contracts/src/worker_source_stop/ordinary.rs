//! Closed ordinary-stop observation DATA. A successful census is necessary
//! when an optional inspect fails; an exit code alone never proves absence.
use super::*;
use std::collections::BTreeSet;

fn first(raw: &[u8]) -> Result<Value> {
    let mut value = legacy_json::decode_python_str(raw).map_err(|_| SourceStopDataError::Json)?;
    let Node::Array(rows) = &mut value.0 else {
        return Err(SourceStopDataError::Identity);
    };
    if rows.is_empty() || object(&rows[0]).is_none() {
        return Err(SourceStopDataError::Identity);
    }
    Ok(rows.remove(0))
}
/// Original first-row Running truthiness, with the immutable identity needed
/// to prevent a name replacement from becoming a different effect target.
pub struct OrdinaryContainer {
    id: ContainerId,
    running: bool,
    stopped: bool,
}
impl OrdinaryContainer {
    pub fn decode(
        raw: &[u8],
        name: &str,
        deployment: &str,
        session: &ProfileSessionId,
    ) -> Result<Self> {
        let row = first(raw)?;
        let Some(Value(Node::String(id))) = field(&row, "Id") else {
            return Err(SourceStopDataError::Identity);
        };
        let id =
            id.0.iter()
                .copied()
                .map(char::from_u32)
                .collect::<Option<String>>()
                .and_then(|id| ContainerId::parse(&id).ok())
                .ok_or(SourceStopDataError::Identity)?;
        let labels = field(&row, "Config").and_then(|value| field(value, "Labels"));
        if !matches(field(&row, "Name"), &format!("/{name}"))
            || !matches(
                labels.and_then(|value| field(value, "reverie.worker")),
                deployment,
            )
            || !matches(
                labels.and_then(|value| field(value, "reverie.session")),
                session.as_str(),
            )
        {
            return Err(SourceStopDataError::Identity);
        }
        let running = field(&row, "State")
            .and_then(|value| field(value, "Running"))
            .ok_or(SourceStopDataError::State)?;
        Ok(Self {
            id,
            running: legacy_json::truthy(Some(running)),
            stopped: matches!(running, Value(Node::Bool(false))),
        })
    }
    pub fn id(&self) -> &ContainerId {
        &self.id
    }
    pub fn running(&self) -> bool {
        self.running
    }
    /// A falsey malformed value cannot acknowledge stopped/release.
    pub fn stopped(&self) -> bool {
        self.stopped
    }
}

/// An owned network observed by its original name, bound to an immutable ID.
/// Foreign labels deliberately produce None, preserving the legacy no-op.
pub struct OrdinaryNetwork {
    id: String,
    name: String,
}
impl OrdinaryNetwork {
    pub fn decode(
        raw: &[u8],
        name: &str,
        deployment: &str,
        session: &ProfileSessionId,
    ) -> Result<Option<Self>> {
        let row = first(raw)?;
        let labels = field(&row, "Labels");
        let labels = labels.filter(|value| legacy_json::truthy(Some(value)));
        if labels.is_some_and(|value| object(value).is_none()) {
            return Err(SourceStopDataError::Identity);
        }
        if !matches(
            labels.and_then(|value| field(value, "reverie.worker")),
            deployment,
        ) || !matches(
            labels.and_then(|value| field(value, "reverie.session")),
            session.as_str(),
        ) {
            return Ok(None);
        }
        if !matches(field(&row, "Name"), name) {
            return Err(SourceStopDataError::Identity);
        }
        let Some(Value(Node::String(id))) = field(&row, "Id") else {
            return Err(SourceStopDataError::Identity);
        };
        let id =
            id.0.iter()
                .copied()
                .map(char::from_u32)
                .collect::<Option<String>>()
                .filter(|id| canonical_id(id))
                .ok_or(SourceStopDataError::Identity)?;
        Ok(Some(Self {
            id,
            name: name.to_owned(),
        }))
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
}
fn canonical_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn engine_name(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}
fn absent(raw: &[u8], name: &str, expected: Option<&str>) -> Result<bool> {
    let raw = std::str::from_utf8(raw).map_err(|_| SourceStopDataError::Identity)?;
    if !raw.is_ascii() {
        return Err(SourceStopDataError::Identity);
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut found = false;
    for line in raw.lines() {
        let mut fields = line.split_ascii_whitespace();
        let (Some(id), Some(observed)) = (fields.next(), fields.next()) else {
            return Err(SourceStopDataError::Identity);
        };
        if fields.next().is_some()
            || !canonical_id(id)
            || !engine_name(observed)
            || !ids.insert(id)
            || !names.insert(observed)
        {
            return Err(SourceStopDataError::Identity);
        }
        found |= observed == name || expected == Some(id);
    }
    Ok(!found)
}
/// Decode fixed `ps --all --no-trunc --format '{{.ID}} {{.Names}}'` output.
/// Both the selected name and any captured immutable ID must be absent.
pub fn ordinary_container_absent(raw: &[u8], name: &str, id: Option<&ContainerId>) -> Result<bool> {
    absent(raw, name, id.map(ContainerId::as_str))
}
/// Decode fixed `network ls --no-trunc --format '{{.ID}} {{.Name}}'` output.
pub fn ordinary_network_absent(raw: &[u8], name: &str, id: Option<&str>) -> Result<bool> {
    absent(raw, name, id)
}
