//! Named read-side laptop registry/lineage facts. No authorization or write API.
mod lineage;
mod registry;

use crate::legacy_json::{self, Node, Number, Text, Value};
pub use lineage::StoredBinding;
pub use registry::{CompanyRecords, CurrentEmployee, RegistryEmployee};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityDataError {
    InvalidJson,
    DuplicateKey,
    Registry,
    RegistryBound,
    Owner,
    AmbiguousRegistry,
    StoredBinding,
    StoredBindingConflict,
    PlanJournal,
    PlanPhase,
    PlanEmployee,
    AmbiguousPlanIdentity,
    CurrentRegistry,
    CurrentGeneration,
    CanonicalIdentity,
}
impl IdentityDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidJson => "METADATA_JSON",
            Self::DuplicateKey => "DUPLICATE_KEY",
            Self::Registry => "EMPLOYEE_REGISTRY",
            Self::RegistryBound => "EMPLOYEE_REGISTRY_BOUND",
            Self::Owner => "EMPLOYEE_OWNER",
            Self::AmbiguousRegistry => "AMBIGUOUS_EMPLOYEE_IDENTITY",
            Self::StoredBinding => "STORED_EMPLOYEE_BINDING",
            Self::StoredBindingConflict => "STORED_EMPLOYEE_BINDING_CONFLICT",
            Self::PlanJournal => "PLAN_STORAGE_JOURNAL",
            Self::PlanPhase => "PLAN_STORAGE_PHASE",
            Self::PlanEmployee => "PLAN_STORAGE_EMPLOYEE",
            Self::AmbiguousPlanIdentity => "AMBIGUOUS_PLAN_STORAGE",
            Self::CurrentRegistry => "CURRENT_EMPLOYEE_REGISTRY",
            Self::CurrentGeneration => "CURRENT_EMPLOYEE_GENERATION",
            Self::CanonicalIdentity => "CANONICAL_STORAGE_IDENTITY",
        }
    }
}
impl fmt::Display for IdentityDataError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for IdentityDataError {}
type Result<T> = std::result::Result<T, IdentityDataError>;

/// Python text, preserving Unicode codepoints and lone surrogates without loss.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct MetadataText(Text);
impl MetadataText {
    pub fn from_scalar_text(value: &str) -> Self {
        Self(Text(value.chars().map(u32::from).collect()))
    }
    pub fn codepoints(&self) -> &[u32] {
        &self.0.0
    }
    pub fn scalar_text(&self) -> Option<String> {
        self.0
            .0
            .iter()
            .map(|&value| char::from_u32(value))
            .collect()
    }
    fn equals_ascii(&self, value: &str) -> bool {
        self.0.equals_ascii(value)
    }
}
/// Positive Python integer generation; it deliberately has no JS-safe ceiling.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmployeeGeneration(String);
impl EmployeeGeneration {
    pub fn decimal(&self) -> &str {
        &self.0
    }
}

/// Duplicate-free json.loads(bytes) data. Named views validate their own shapes;
/// successful decoding alone is neither a registry nor a host-effect capability.
pub struct Metadata(Value);
pub fn decode_metadata(raw: &[u8]) -> Result<Metadata> {
    legacy_json::decode_bytes(raw)
        .map(Metadata)
        .map_err(|error| match error {
            legacy_json::Error::InvalidJson => IdentityDataError::InvalidJson,
            legacy_json::Error::DuplicateKey => IdentityDataError::DuplicateKey,
        })
}
type Object = BTreeMap<Text, Value>;
fn object(value: &Value) -> Option<&Object> {
    if let Node::Object(values) = &value.0 {
        Some(values)
    } else {
        None
    }
}
fn field<'a>(value: &'a Object, key: &str) -> Option<&'a Value> {
    value.get(&Text(key.bytes().map(u32::from).collect()))
}
fn text(value: Option<&Value>) -> Option<MetadataText> {
    if let Some(Value(Node::String(value))) = value {
        Some(MetadataText(value.clone()))
    } else {
        None
    }
}
fn owner(value: Option<&Value>) -> Result<Option<MetadataText>> {
    match value {
        None | Some(Value(Node::Null)) => Ok(None),
        Some(Value(Node::String(value))) if value.0.len() <= 200 => {
            Ok(Some(MetadataText(value.clone())))
        }
        _ => Err(IdentityDataError::Owner),
    }
}
fn owner_matches(value: Option<&Value>, owner: &Option<MetadataText>) -> bool {
    match value {
        None | Some(Value(Node::Null)) => owner.is_none(),
        Some(value) => owner
            .as_ref()
            .is_some_and(|expected| value.python_eq(&Value(Node::String(expected.0.clone())))),
    }
}
fn is_one(value: Option<&Value>) -> bool {
    match value {
        Some(Value(Node::Bool(true))) => true,
        Some(Value(Node::Number(Number::Integer(value)))) => value == "1",
        Some(Value(Node::Number(Number::Float(value)))) => *value == 1.0,
        _ => false,
    }
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value(Node::Null | Node::Bool(false))) => false,
        Some(Value(Node::Number(Number::Integer(value)))) => value != "0",
        Some(Value(Node::Number(Number::Float(value)))) => *value != 0.0,
        Some(Value(Node::String(value))) => !value.0.is_empty(),
        Some(Value(Node::Array(value))) => !value.is_empty(),
        Some(Value(Node::Object(value))) => !value.is_empty(),
        _ => true,
    }
}
fn employee_id(value: &MetadataText) -> Result<ProfileEmployeeId> {
    ProfileEmployeeId::parse(
        &value
            .scalar_text()
            .ok_or(IdentityDataError::CanonicalIdentity)?,
    )
    .map_err(|_| IdentityDataError::CanonicalIdentity)
}
fn session_matches(value: Option<&Value>, session: &ProfileSessionId) -> bool {
    text(value).is_some_and(|value| value.equals_ascii(session.as_str()))
}
