//! Original reservation observation data/byte owners. Parsed company rows,
//! profiles and native binding dictionaries never confer runtime authority.
mod digests;
mod employee;
mod observation;
use crate::{
    legacy_json::{Node, Number, Text, Value},
    storage_identity::Metadata,
};
pub use digests::{
    PoolWebsite, claim_source_binding_digest, pool_revision_digest, source_binding_digest,
};
pub use employee::{ClaimEmployee, ReservationEmployee};
pub use observation::{ReservationObservation, ReservationObservationFields};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    revision::Generation,
};
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationDataError {
    /// Original company indexing/iteration raises KeyError, TypeError or
    /// AttributeError here, outside cold recovery's ordinary refusal catch.
    CompanyStructure,
    CurrentEmployee,
    Generation,
    Fingerprint,
}
impl ObservationDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::CompanyStructure => "RESERVATION_COMPANY_STRUCTURE",
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
        Err(ObservationDataError::CompanyStructure)
    }
}
fn matches_text(value: Option<&Value>, text: &str) -> bool {
    matches!(value,Some(Value(Node::String(value))) if value.equals_ascii(text))
}
fn employees(metadata: &Metadata) -> Result<&[Value]> {
    let root = object(metadata.as_value())?;
    match root.get(&key("employees")) {
        Some(Value(Node::Array(values))) => Ok(values),
        // Python permits iteration of empty dictionaries/strings. They select
        // no session and reach the ordinary storage-identity refusal later.
        Some(Value(Node::Object(values))) if values.is_empty() => Ok(&[]),
        Some(Value(Node::String(value))) if value.0.is_empty() => Ok(&[]),
        _ => Err(ObservationDataError::CompanyStructure),
    }
}
