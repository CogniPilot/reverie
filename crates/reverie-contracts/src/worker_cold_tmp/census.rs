//! Broker.admit_cold_temporary's full512-ID census and Python projection.
//! Native observation/custody and the 4MiB process bound are separate owners.
use super::*;
use crate::legacy_json::{self, Number};
use reverie_core::{PythonText, ids::ContainerId};
use std::collections::BTreeSet;
const MAX_CONTAINERS: usize = 512;
mod retained;
pub use retained::RetainedInspection;

pub struct ColdInventoryIds {
    values: Vec<ContainerId>,
}
impl ColdInventoryIds {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        let raw = std::str::from_utf8(raw).map_err(|_| ColdDataError::Inventory)?;
        let raw = PythonText::from_scalar_text(raw);
        let mut values = Vec::new();
        let mut seen = BTreeSet::new();
        for word in raw.split_whitespace() {
            if values.len() >= MAX_CONTAINERS {
                return Err(ColdDataError::Inventory);
            }
            let text = word.scalar_text().ok_or(ColdDataError::Inventory)?;
            let id = ContainerId::parse(&text).map_err(|_| ColdDataError::Inventory)?;
            if !seen.insert(id.as_str().to_owned()) {
                return Err(ColdDataError::Inventory);
            }
            values.push(id);
        }
        Ok(Self { values })
    }
    pub fn values(&self) -> &[ContainerId] {
        &self.values
    }
    pub fn same_set(&self, other: &Self) -> bool {
        self.values.len() == other.values.len()
            && self
                .values
                .iter()
                .all(|id| other.values.iter().any(|v| v == id))
    }
}
pub struct ColdInventory {
    rows: Vec<ColdContainer>,
}
impl ColdInventory {
    pub fn decode(raw: &[u8], expected: &ColdInventoryIds) -> Result<Self> {
        let raw = legacy_json::decode_engine_inventory(raw).map_err(|_| ColdDataError::Json)?;
        let Node::Array(values) = &raw.0 else {
            return Err(ColdDataError::Inventory);
        };
        if values.len() != expected.values.len() {
            return Err(ColdDataError::Inventory);
        }
        let mut rows = Vec::new();
        let mut seen = BTreeSet::new();
        for value in values {
            let fields = object(value).ok_or(ColdDataError::Inventory)?;
            let text = metadata(field(fields, "Id"), ColdDataError::Inventory)?;
            let scalar = text.scalar_text().ok_or(ColdDataError::Inventory)?;
            let id = ContainerId::parse(&scalar).map_err(|_| ColdDataError::Inventory)?;
            if !expected.values.contains(&id) || !seen.insert(id.as_str().to_owned()) {
                return Err(ColdDataError::Inventory);
            }
            rows.push(ColdContainer {
                id,
                raw: value.deep_clone(),
            });
        }
        Ok(Self { rows })
    }
    pub fn rows(&self) -> &[ColdContainer] {
        &self.rows
    }
    /// Python dictionary/container equality of sorted selected fields. Byte
    /// fingerprints would wrongly distinguish bool/int/float equivalents.
    pub fn same_projection(&self, other: &Self) -> Result<bool> {
        Ok(self.projection()?.python_eq(&other.projection()?))
    }
    fn projection(&self) -> Result<Value> {
        let mut rows = self.rows.iter().collect::<Vec<_>>();
        rows.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));
        Ok(Value(Node::Array(
            rows.into_iter()
                .map(ColdContainer::projection)
                .collect::<Result<_>>()?,
        )))
    }
}
pub struct ColdContainer {
    id: ContainerId,
    raw: Value,
}
impl ColdContainer {
    fn fields(&self) -> &Object {
        object(&self.raw).expect("decoded cold object")
    }
    pub fn id(&self) -> &ContainerId {
        &self.id
    }
    pub fn named(&self, name: &str) -> bool {
        matches!(field(self.fields(),"Name"),Some(Value(Node::String(text))) if text.equals_ascii(name))
    }
    pub fn state(&self) -> Result<ColdContainerState<'_>> {
        let state = self.state_fields()?;
        self.mount_values()?;
        Ok(state)
    }
    fn state_fields(&self) -> Result<ColdContainerState<'_>> {
        let state = field(self.fields(), "State")
            .and_then(object)
            .ok_or(ColdDataError::State)?;
        let boolean = |name| match field(state, name) {
            Some(Value(Node::Bool(value))) => Ok(*value),
            _ => Err(ColdDataError::State),
        };
        let Some(Value(Node::Number(Number::Integer(pid)))) = field(state, "Pid") else {
            return Err(ColdDataError::State);
        };
        Ok(ColdContainerState {
            running: boolean("Running")?,
            paused: boolean("Paused")?,
            restarting: boolean("Restarting")?,
            pid,
        })
    }
    pub fn has_bind(&self) -> Result<bool> {
        Ok(self.mount_values()?.iter().any(|v| {
            object(v)
                .and_then(|v| field(v, "Type"))
                .is_some_and(|v| matches!(&v.0,Node::String(text) if text.equals_ascii("bind")))
        }))
    }
    /// Preserve source order and defer Source/Destination/RW reads to their
    /// actual observation phase instead of eager normalization.
    pub fn mounts(&self) -> Result<impl Iterator<Item = Result<Option<ColdBind<'_>>>>> {
        Ok(self.mount_values()?.iter().map(|value| {
            let data=object(value).ok_or(ColdDataError::Mounts)?;
            if matches!(field(data,"Type"),Some(Value(Node::String(value))) if value.equals_ascii("bind")) {Ok(Some(ColdBind{data}))}
            else {Ok(None)}
        }))
    }
    fn mount_values(&self) -> Result<&[Value]> {
        match field(self.fields(), "Mounts") {
            Some(Value(Node::Array(values))) => Ok(values),
            _ => Err(ColdDataError::Mounts),
        }
    }
    fn projection(&self) -> Result<Value> {
        let fields = self.fields();
        let state = field(fields, "State")
            .and_then(object)
            .ok_or(ColdDataError::State)?;
        let selected = |source: &Object, name: &str| {
            field(source, name).map_or(Value(Node::Null), Value::deep_clone)
        };
        let mut mounts = self
            .mount_values()?
            .iter()
            .map(|v| (worker_config::encode_data(v), v))
            .collect::<Vec<_>>();
        mounts.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(Value(Node::Object(BTreeMap::from([
            (key("id"), selected(fields, "Id")),
            (key("name"), selected(fields, "Name")),
            (
                key("state"),
                Value(Node::Object(
                    [
                        "Running",
                        "Paused",
                        "Restarting",
                        "Dead",
                        "Pid",
                        "StartedAt",
                    ]
                    .map(|name| (key(name), selected(state, name)))
                    .into(),
                )),
            ),
            (
                key("mounts"),
                Value(Node::Array(
                    mounts.into_iter().map(|(_, v)| v.deep_clone()).collect(),
                )),
            ),
        ]))))
    }
}
pub struct ColdContainerState<'a> {
    running: bool,
    paused: bool,
    restarting: bool,
    pid: &'a str,
}
impl ColdContainerState<'_> {
    pub fn active(&self) -> bool {
        self.running || self.paused || self.restarting || self.pid != "0"
    }
    pub fn pid_text(&self) -> &str {
        self.pid
    }
}
pub struct ColdBind<'a> {
    data: &'a Object,
}
impl ColdBind<'_> {
    pub fn source(&self) -> Result<MetadataText> {
        metadata(field(self.data, "Source"), ColdDataError::Mounts)
    }
    pub fn destination(&self) -> Result<MetadataText> {
        metadata(field(self.data, "Destination"), ColdDataError::Mounts)
    }
    pub fn writable(&self) -> Result<bool> {
        match field(self.data, "RW") {
            Some(Value(Node::Bool(value))) => Ok(*value),
            _ => Err(ColdDataError::Mounts),
        }
    }
}
