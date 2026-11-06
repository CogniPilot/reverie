//! Original reservation observation data/byte owners. Parsed company rows,
//! profiles and native binding dictionaries never confer runtime authority.
mod digests;
mod employee;
mod observation;
use crate::{
    legacy_json::{Node, Number, Text, Value},
    storage_identity::Metadata,
};
pub use digests::{PoolWebsite, pool_revision_digest, source_binding_digest};
pub use employee::ReservationEmployee;
pub use observation::{ReservationObservation, ReservationObservationFields};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    revision::Generation,
};
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationDataError {
    CurrentEmployee,
    Generation,
    Fingerprint,
}
impl ObservationDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::CurrentEmployee => "RESERVATION_CURRENT_EMPLOYEE_REQUIRED",
            Self::Generation => "RESERVATION_GENERATION",
            Self::Fingerprint => "RESERVATION_OBSERVATION_FINGERPRINT",
        }
    }
}
impl fmt::Display for ObservationDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ObservationDataError {}
type Result<T> = std::result::Result<T, ObservationDataError>;
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn object(value: &Value) -> Result<&Object> {
    if let Node::Object(fields) = &value.0 {
        Ok(fields)
    } else {
        Err(ObservationDataError::CurrentEmployee)
    }
}
fn matches_text(value: Option<&Value>, text: &str) -> bool {
    matches!(value,Some(Value(Node::String(value))) if value.equals_ascii(text))
}
fn employees(metadata: &Metadata) -> Result<&[Value]> {
    let root = object(metadata.as_value())?;
    match root.get(&key("employees")) {
        Some(Value(Node::Array(values))) => Ok(values),
        _ => Err(ObservationDataError::CurrentEmployee),
    }
}
