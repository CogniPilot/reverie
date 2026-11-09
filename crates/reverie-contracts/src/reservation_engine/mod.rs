//! Lossless fixed-engine inventory data. Native observation, authorization and
//! admission authority are separate; all unknown row/mount fields are retained.
mod binding;
mod config;
mod fields;
mod row;
mod stopped;
mod stopped_ram;
use crate::legacy_json::{self, Node, Number, Text, Value};
use crate::storage_identity::MetadataText;
pub use binding::{NativeLimitBinding, NativeStorageBinding};
pub use config::{
    ControlBindingPaths, ControlPaths, ObservedMemoryPolicy, ReservationConfiguration,
    StorageIdentityRef, StoragePathText,
};
pub use fields::{DeclaredLimits, NativeLimitFields};
use reverie_core::{decimal::UnsignedInteger, ids::ContainerId};
pub use row::{ContainerRow, StoppedWebsite};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt};
pub use stopped::{StoppedFlag, StoppedState};
pub use stopped_ram::StoppedRamDeclaration;
pub const MAX_CONTAINERS: usize = 2048;
pub const MAX_NATIVE_BYTES: usize = 8 * 1_048_576;
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, EngineDataError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineDataError {
    Json,
    Bound,
    Inventory,
    Mounts,
    StoppedRow,
    StoppedWebsiteRequired,
    StoppedWebsiteLimits,
    StoppedObservation,
    StoppedChanged,
    State,
    /// Legacy native indexing/attribute failure outside recovery's ordinary
    /// OSError/ValueError/RuntimeError refusal catch.
    Structure,
    NotRunning,
    FiniteLimits,
    Image,
    Pid,
    Policy,
    Storage,
    Nonfinite,
}
impl EngineDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Json => "RESERVATION_ENGINE_JSON",
            Self::Bound => "RESERVATION_ENGINE_BOUND",
            Self::Inventory => "RESERVATION_COMPLETE_INVENTORY",
            Self::Mounts => "RESERVATION_MOUNT_INVENTORY",
            Self::StoppedRow => "RESERVATION_STOPPED_ROW",
            Self::StoppedWebsiteRequired => "RESERVATION_STOPPED_WEBSITE_REQUIRED",
            Self::StoppedWebsiteLimits => "RESERVATION_STOPPED_WEBSITE_LIMITS",
            Self::StoppedObservation => "RESERVATION_STOPPED_OBSERVATION",
            Self::StoppedChanged => "RESERVATION_STOPPED_IDENTITY_CHANGED",
            Self::State => "RESERVATION_NATIVE_STATE",
            Self::Structure => "RESERVATION_NATIVE_STRUCTURE",
            Self::NotRunning => "RESERVATION_SOURCE_NOT_RUNNING",
            Self::FiniteLimits => "RESERVATION_NATIVE_FINITE_LIMITS",
            Self::Image => "RESERVATION_NATIVE_IMAGE",
            Self::Pid => "RESERVATION_NATIVE_PID",
            Self::Policy => "RESERVATION_SOURCE_POLICY",
            Self::Storage => "RESERVATION_NATIVE_STORAGE_BINDING",
            Self::Nonfinite => "RESERVATION_NONFINITE_FINGERPRINT",
        }
    }
}
impl fmt::Display for EngineDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for EngineDataError {}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InventoryDigest([u8; 32]);
impl InventoryDigest {
    pub fn to_hex(&self) -> String {
        crate::digest::hex(&self.0)
    }
}
pub struct InventoryRows {
    rows: Vec<ContainerRow>,
}
/// Incremental data decoder. Each native batch is counted and JSON-decoded
/// before the application may issue its next query. Global IDs and mount
/// normalization remain deferred until the complete census is available.
pub struct InventoryDecoder {
    ids: Vec<ContainerId>,
    received: usize,
    values: Vec<Value>,
    failure: Option<EngineDataError>,
}
impl InventoryDecoder {
    pub fn new(ids: &[ContainerId]) -> Result<Self> {
        if ids.len() > MAX_CONTAINERS
            || ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len()
        {
            return Err(EngineDataError::Inventory);
        }
        Ok(Self {
            ids: ids.to_vec(),
            received: 0,
            values: Vec::new(),
            failure: None,
        })
    }
    pub fn push(&mut self, stdout: &str) -> Result<()> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let result = self.decode_batch(stdout);
        if let Err(error) = result {
            self.failure = Some(error);
        }
        result
    }
    fn decode_batch(&mut self, stdout: &str) -> Result<()> {
        if self.received >= self.ids.len() {
            return Err(EngineDataError::Inventory);
        }
        if stdout.len() > MAX_NATIVE_BYTES {
            return Err(EngineDataError::Bound);
        }
        let lines = splitlines(stdout);
        if lines.len() != (self.ids.len() - self.received).min(32) {
            return Err(EngineDataError::Inventory);
        }
        for line in &lines {
            self.values.push(default_json(line.as_bytes())?);
        }
        self.received += lines.len();
        Ok(())
    }
    pub fn finish(self) -> Result<InventoryRows> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.received != self.ids.len() {
            return Err(EngineDataError::Inventory);
        }
        let mut rows = self
            .values
            .into_iter()
            .map(ContainerRow::capture)
            .collect::<Result<Vec<_>>>()?;
        let mut expected = self.ids;
        expected.sort();
        let mut observed = rows.iter().map(ContainerRow::id).collect::<Vec<_>>();
        observed.sort();
        if observed.iter().copied().ne(expected.iter()) {
            return Err(EngineDataError::Inventory);
        }
        for row in &mut rows {
            sorted_mounts(&mut row.value)?;
        }
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(InventoryRows { rows })
    }
}
impl InventoryRows {
    /// IDs come from the complete ps query. Decode one fixed inspect result per
    /// supplied batch, retaining default JSON last-wins and Python number kinds.
    pub fn decode(ids: &[ContainerId], batches: &[String]) -> Result<Self> {
        let mut decoder = InventoryDecoder::new(ids)?;
        if batches.len() != ids.len().div_ceil(32) {
            return Err(EngineDataError::Inventory);
        }
        for batch in batches {
            decoder.push(batch)?;
        }
        decoder.finish()
    }
    pub fn rows(&self) -> &[ContainerRow] {
        &self.rows
    }
    pub fn equivalent(&self, other: &Self) -> bool {
        self.rows.len() == other.rows.len()
            && self
                .rows
                .iter()
                .zip(&other.rows)
                .all(|(a, b)| a.value.python_eq(&b.value))
    }
    pub fn mount_shape(&self) -> Result<Vec<(ContainerId, InventoryDigest)>> {
        self.rows
            .iter()
            .map(|row| Ok((row.id.clone(), row.mounts_digest()?)))
            .collect()
    }
}
pub fn inventory_ids(stdout: &str) -> Result<Vec<ContainerId>> {
    if stdout.len() > MAX_NATIVE_BYTES {
        return Err(EngineDataError::Bound);
    }
    let ids = splitlines(stdout)
        .into_iter()
        .map(|line| ContainerId::parse(line).map_err(|_| EngineDataError::Inventory))
        .collect::<Result<Vec<_>>>()?;
    if ids.len() > MAX_CONTAINERS
        || ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len()
    {
        return Err(EngineDataError::Inventory);
    }
    Ok(ids)
}
pub(crate) fn splitlines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut begin = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if matches!(
            ch,
            '\n' | '\r'
                | '\u{b}'
                | '\u{c}'
                | '\u{1c}'
                | '\u{1d}'
                | '\u{1e}'
                | '\u{85}'
                | '\u{2028}'
                | '\u{2029}'
        ) {
            result.push(&text[begin..index]);
            begin = index + ch.len_utf8();
            if ch == '\r' && chars.peek().is_some_and(|(_, ch)| *ch == '\n') {
                let (index, _) = chars.next().expect("peeked LF");
                begin = index + 1;
            }
        }
    }
    if begin < text.len() {
        result.push(&text[begin..]);
    }
    result
}
fn default_json(raw: &[u8]) -> Result<Value> {
    legacy_json::decode_engine_inventory(raw).map_err(|_| EngineDataError::Json)
}
fn key(value: &str) -> Text {
    Text(value.bytes().map(u32::from).collect())
}
fn field<'a>(root: &'a Object, name: &str) -> Option<&'a Value> {
    root.get(&key(name))
}
fn object(value: &Value) -> Result<&Object> {
    if let Node::Object(value) = &value.0 {
        Ok(value)
    } else {
        Err(EngineDataError::State)
    }
}
fn text(value: Option<&Value>) -> Option<&Text> {
    if let Some(Value(Node::String(value))) = value {
        Some(value)
    } else {
        None
    }
}
fn unsigned(value: Option<&Value>) -> Result<UnsignedInteger> {
    match value {
        Some(Value(Node::Number(Number::Integer(value)))) => {
            UnsignedInteger::parse(value).ok_or(EngineDataError::FiniteLimits)
        }
        _ => Err(EngineDataError::FiniteLimits),
    }
}
fn compact(value: &Value) -> Result<Vec<u8>> {
    if !value.is_finite() {
        return Err(EngineDataError::Nonfinite);
    }
    Ok(crate::worker_config::compact_data(value))
}
fn digest(value: &Value) -> Result<InventoryDigest> {
    Ok(InventoryDigest(Sha256::digest(compact(value)?).into()))
}
fn sorted_mounts(value: &mut Value) -> Result<()> {
    let Node::Object(root) = &mut value.0 else {
        return Err(EngineDataError::Inventory);
    };
    let Some(Value(Node::Array(mounts))) = root.get_mut(&key("Mounts")) else {
        return Err(EngineDataError::Mounts);
    };
    if !mounts
        .iter()
        .all(|value| matches!(value.0, Node::Object(_)))
    {
        return Err(EngineDataError::Mounts);
    }
    let mut values = Vec::new();
    for mount in std::mem::take(mounts) {
        values.push((compact(&mount)?, mount));
    }
    values.sort_by(|(a, _), (b, _)| a.cmp(b));
    *mounts = values.into_iter().map(|(_, mount)| mount).collect();
    Ok(())
}
