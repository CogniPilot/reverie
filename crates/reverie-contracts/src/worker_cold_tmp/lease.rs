//! Clear uses Path.read_text last-wins JSON; retirement uses pinned strict
//! bytes metadata. A row never replaces actual kernel-flock observation.
use super::numbers::Timestamp;
use super::*;
use crate::legacy_json::{self, Number, truthy};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColdLeaseState {
    Free,
    InUse,
    Unknown,
}
/// Parse before the real reader observes wall time, matching _reservation_state
/// → json.loads → _reservation_value_state. This remains DATA, never a lease.
pub struct ClearReservation(std::result::Result<Option<Value>, ColdDataError>);
impl ClearReservation {
    pub fn decode(raw: Option<&[u8]>) -> Self {
        Self(raw.map(clear_decode).transpose())
    }
    pub fn state(&self, now: f64) -> Result<ColdLeaseState> {
        match &self.0 {
            Ok(None) => Ok(ColdLeaseState::Free),
            Ok(Some(value)) => state(value, now),
            Err(_) => Ok(ColdLeaseState::Unknown),
        }
    }
}
fn one(value: Option<&Value>) -> bool {
    value.is_some_and(|value| legacy_json::numeric_key(&value.0).as_deref() == Some("1"))
}
fn clear_decode(raw: &[u8]) -> Result<Value> {
    let text = legacy_json::utf8_file_text(raw).map_err(|_| ColdDataError::Lease)?;
    legacy_json::decode_python_str(text.as_bytes()).map_err(|_| ColdDataError::Lease)
}
pub(super) fn strict_record(raw: &[u8]) -> Result<Value> {
    let value = legacy_json::decode_metadata_bytes(raw).map_err(|_| ColdDataError::Lease)?;
    let fields = object(&value).ok_or(ColdDataError::Lease)?;
    if !matches!(field(fields,"version"),Some(Value(Node::Number(Number::Integer(value)))) if value=="1")
    {
        return Err(ColdDataError::Lease);
    }
    Ok(value)
}
/// Missing file and present JSON null are FREE. A real reader's I/O failure
/// must be UNKNOWN, never converted into the missing-file argument.
pub fn clear_reservation(raw: Option<&[u8]>, now: f64) -> Result<ColdLeaseState> {
    ClearReservation::decode(raw).state(now)
}
pub fn retained_reservation(raw: &[u8], now: f64) -> Result<ColdLeaseState> {
    state(&strict_record(raw)?, now)
}
pub(super) fn state(value: &Value, now: f64) -> Result<ColdLeaseState> {
    if matches!(value.0, Node::Null) {
        return Ok(ColdLeaseState::Free);
    }
    let Some(fields) = object(value) else {
        return Ok(ColdLeaseState::Unknown);
    };
    if !one(field(fields, "version")) || truthy(field(fields, "malformed")) {
        return Ok(ColdLeaseState::Unknown);
    }
    let (Some(created), Some(until)) = (
        Timestamp::capture(field(fields, "created_utc")),
        Timestamp::capture(field(fields, "until_utc")),
    ) else {
        return Ok(ColdLeaseState::Unknown);
    };
    if !created.valid_window(&until)?
        || !created.no_later_than(now + 60.0)
        || !until.close_enough_to(now)?
    {
        return Ok(ColdLeaseState::Unknown);
    }
    Ok(if until.no_later_than(now) {
        ColdLeaseState::Free
    } else {
        ColdLeaseState::InUse
    })
}
pub fn clear_path_metadata(raw: Option<&[u8]>) -> Result<()> {
    let Some(raw) = raw else {
        return Ok(());
    };
    let value = clear_decode(raw)?;
    let fields = object(&value).ok_or(ColdDataError::Lease)?;
    if !one(field(fields, "version"))
        || !matches!(field(fields, "path"), Some(Value(Node::String(_))))
    {
        return Err(ColdDataError::Lease);
    }
    Ok(())
}
/// Original clear _metadata parses holder JSON without normalizing its shape.
pub fn clear_holder_metadata(raw: &[u8]) -> Result<()> {
    clear_decode(raw).map(|_| ())
}
/// None is valid missing path data; actual active/evidence and canonical path
/// requirements belong to the fixed retirement inventory consumer.
pub fn retained_record_path(raw: &[u8]) -> Result<Option<MetadataText>> {
    let value = strict_record(raw)?;
    let fields = object(&value).expect("strict object");
    match field(fields, "path") {
        None => Ok(None),
        value => metadata(value, ColdDataError::Lease).map(Some),
    }
}
