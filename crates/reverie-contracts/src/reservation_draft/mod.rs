//! Fixed private preview DATA. A matching hash is neither owner approval nor a
//! journal lease. Claim-time observation conversion deliberately rejects nil
//! journal identities that the legacy read-side preview can represent.
mod record;
use crate::{
    legacy_json::{Node, Text, Value},
    reservation_observation::ReservationObservation,
};
pub use record::{DraftFields, DraftRecord};
use reverie_core::{
    operations::{JournalDigest, JournalId, OperationDocument, OperationScope},
    profiles::ResourceProfile,
};
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, DraftDataError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DraftDataError {
    Changed,
    Ids,
    Fingerprint,
    Bound,
    Profile(crate::profiles_v1::CodecError),
    Operation(reverie_core::operations::OperationError),
}
impl DraftDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Changed => "RESOURCE_PREPARATION_DRAFT_CHANGED",
            Self::Ids => "RESOURCE_PREPARATION_DRAFT_IDS",
            Self::Fingerprint => "RESOURCE_PREPARATION_DRAFT_FINGERPRINT",
            Self::Bound => "RESOURCE_PREPARATION_DRAFT_BOUND",
            Self::Profile(e) => e.code(),
            Self::Operation(e) => e.code(),
        }
    }
}
impl fmt::Display for DraftDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for DraftDataError {}
impl From<crate::profiles_v1::CodecError> for DraftDataError {
    fn from(e: crate::profiles_v1::CodecError) -> Self {
        Self::Profile(e)
    }
}
impl From<reverie_core::operations::OperationError> for DraftDataError {
    fn from(e: reverie_core::operations::OperationError) -> Self {
        Self::Operation(e)
    }
}
fn key(s: &str) -> Text {
    Text(s.chars().map(u32::from).collect())
}
fn string(s: &str) -> Value {
    Value(Node::String(key(s)))
}
fn object(value: &Value) -> Result<&Object> {
    match &value.0 {
        Node::Object(value) => Ok(value),
        _ => Err(DraftDataError::Changed),
    }
}
fn field<'a>(value: &'a Object, name: &str) -> Result<&'a Value> {
    value.get(&key(name)).ok_or(DraftDataError::Changed)
}
fn scalar(value: &Value) -> Result<String> {
    match &value.0 {
        Node::String(value) => value
            .0
            .iter()
            .map(|&p| char::from_u32(p))
            .collect::<Option<String>>()
            .ok_or(DraftDataError::Changed),
        _ => Err(DraftDataError::Changed),
    }
}
fn need(value: bool, error: DraftDataError) -> Result<()> {
    if value { Ok(()) } else { Err(error) }
}
fn digest(value: &Value) -> Result<JournalDigest> {
    let digest =
        crate::reservation_control::fingerprint(value).map_err(|_| DraftDataError::Fingerprint)?;
    Ok(JournalDigest::parse(&crate::digest::hex(&digest)).expect("SHA256"))
}
fn profile_value(profile: &ResourceProfile) -> Result<Value> {
    Ok(crate::profiles_v1::data(profile)?)
}
/// The source counts every native entry, then rejects the 256th draft itself.
/// Codepoint spelling is retained; no canonical directory ordering is imposed.
pub fn validate_directory_names(names: &[Vec<u32>]) -> Result<()> {
    let mut drafts = 0;
    let prefix = key("draft-").0;
    let suffix = key(".json").0;
    for (index, name) in names.iter().enumerate() {
        need(index < 4096, DraftDataError::Bound)?;
        if name.starts_with(&prefix) && name.ends_with(&suffix) {
            drafts += 1;
        }
        need(drafts < 256, DraftDataError::Bound)?;
    }
    Ok(())
}
