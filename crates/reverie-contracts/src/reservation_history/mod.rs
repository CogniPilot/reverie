//! Historical settlement DATA only. An accepted receipt is never a live native
//! completion proof, launch permit, journal handle or permission to credit RAM.
mod completed;
mod pending;
use crate::{
    legacy_json::{Node, Text, Value},
    storage_identity::Metadata,
};
pub use completed::HistoricalCompletion;
pub use pending::{pending_operation_id, validate_pending, validate_pending_position};
use reverie_core::operations::{JournalDigest, OperationError};
use std::{collections::BTreeMap, fmt};

#[derive(Debug)]
pub enum HistoryError {
    Receipt,
    Operation,
    Profile,
    Verification,
    Plan,
    Pending,
    PendingBound,
    Fingerprint,
    ClosedSchema,
    Journal(OperationError),
    ProfileData(crate::profiles_v1::CodecError),
}
impl HistoryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Receipt => "RESOURCE_COMPLETION_RECEIPT_CHANGED",
            Self::Operation => "RESOURCE_COMPLETION_OPERATION_CHANGED",
            Self::Profile => "RESOURCE_COMPLETION_PROFILE_CHANGED",
            Self::Verification => "RESOURCE_COMPLETION_VERIFICATION_CHANGED",
            Self::Plan => "RESOURCE_COMPLETION_PLAN_CHANGED",
            Self::Pending => "RESOURCE_COMPLETION_ORPHAN_PENDING",
            Self::PendingBound => "RESOURCE_COMPLETION_PENDING_BOUND",
            Self::Fingerprint => "RESOURCE_COMPLETION_FINGERPRINT",
            Self::ClosedSchema => "CLOSED_SCHEMA",
            Self::Journal(error) => error.code(),
            Self::ProfileData(error) => error.code(),
        }
    }
}
impl fmt::Display for HistoryError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for HistoryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Journal(error) => Some(error),
            Self::ProfileData(error) => Some(error),
            _ => None,
        }
    }
}
impl From<OperationError> for HistoryError {
    fn from(error: OperationError) -> Self {
        Self::Journal(error)
    }
}
type Result<T> = std::result::Result<T, HistoryError>;
type Object = BTreeMap<Text, Value>;
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn string(value: &str) -> Value {
    Value(Node::String(key(value)))
}
fn object(value: &Value, error: HistoryError) -> Result<&Object> {
    match &value.0 {
        Node::Object(fields) => Ok(fields),
        _ => Err(error),
    }
}
fn exact<'a>(value: &'a Value, names: &[&str]) -> Result<&'a Object> {
    let fields = object(value, HistoryError::ClosedSchema)?;
    if fields.len() == names.len() && names.iter().all(|name| fields.contains_key(&key(name))) {
        Ok(fields)
    } else {
        Err(HistoryError::ClosedSchema)
    }
}
fn get<'a>(object: &'a Object, name: &str) -> Option<&'a Value> {
    object.get(&key(name))
}
fn field<'a>(object: &'a Object, name: &str) -> Result<&'a Value> {
    get(object, name).ok_or(HistoryError::ClosedSchema)
}
fn equals(value: Option<&Value>, text: &str) -> bool {
    value.is_some_and(|value| matches!(&value.0, Node::String(value) if value.equals_ascii(text)))
}
fn same(left: Option<&Value>, right: &Value) -> bool {
    left.is_some_and(|left| left.python_eq(right))
}
fn need(value: bool, error: HistoryError) -> Result<()> {
    if value { Ok(()) } else { Err(error) }
}
fn digest(value: &Value) -> Result<JournalDigest> {
    let raw =
        crate::reservation_control::fingerprint(value).map_err(|_| HistoryError::Fingerprint)?;
    Ok(JournalDigest::parse(&crate::digest::hex(&raw))?)
}
fn digest_field(value: &Value) -> Result<JournalDigest> {
    let Node::String(text) = &value.0 else {
        return Err(HistoryError::Journal(OperationError::new("DIGEST")));
    };
    let text = text
        .0
        .iter()
        .map(|&cp| char::from_u32(cp))
        .collect::<Option<String>>()
        .ok_or(HistoryError::Journal(OperationError::new("DIGEST")))?;
    Ok(JournalDigest::parse(&text)?)
}
