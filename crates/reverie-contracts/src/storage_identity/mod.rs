//! Named read-side laptop registry/lineage facts. No authorization or write API.
mod inventory;
#[cfg(test)]
mod inventory_tests;
pub(crate) mod lineage;
mod provider;
mod registry;
pub use provider::ProviderHealthBinding;
#[cfg(test)]
mod provider_tests;

use crate::legacy_json::{self, Node, Number, Text, Value, truthy};
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
pub struct MetadataText(reverie_core::PythonText);
impl MetadataText {
    pub fn from_python_text(value: reverie_core::PythonText) -> Self {
        Self(value)
    }
    pub(crate) fn from_text(value: Text) -> Self {
        Self(
            reverie_core::PythonText::try_new(value.0)
                .expect("JSON parser produces Python codepoints"),
        )
    }
    pub fn from_scalar_text(value: &str) -> Self {
        Self(reverie_core::PythonText::from_scalar_text(value))
    }
    pub fn codepoints(&self) -> &[u32] {
        self.0.codepoints()
    }
    pub fn as_python_text_ref(&self) -> reverie_core::PythonTextRef<'_> {
        self.0.as_text_ref()
    }
    pub fn scalar_text(&self) -> Option<String> {
        self.0
            .codepoints()
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
/// Metadata data retaining actual object order where a named native workflow
/// must preserve its filesystem observation order. No editing API is exposed.
pub struct OrderedMetadata(legacy_json::ordered::OrderedValue);
impl OrderedMetadata {
    pub(crate) fn ordered(&self) -> &legacy_json::ordered::OrderedValue {
        &self.0
    }
    pub(crate) fn as_value(&self) -> &Value {
        &self.0.value
    }
    pub(crate) fn object_field_order(&self, name: &str) -> Option<Vec<Text>> {
        let name = Text(name.chars().map(u32::from).collect());
        let index = self.0.root_child_index(&name)?;
        let legacy_json::ordered::OrderNode::Object(order) = self.0.graph.nodes.get(index)? else {
            return None;
        };
        Some(order.iter().map(|(name, _)| name.clone()).collect())
    }
}
pub fn decode_ordered_metadata(raw: &[u8]) -> Result<OrderedMetadata> {
    legacy_json::decode_ordered_metadata_bytes(raw)
        .map(OrderedMetadata)
        .map_err(decode_error)
}

impl Metadata {
    /// Python equality of complete metadata DATA, retaining codepoints and
    /// number semantics. This is not a current-file or identity permission.
    pub fn equivalent(&self, other: &Self) -> bool {
        self.0.python_eq(&other.0)
    }
    pub(crate) fn as_value(&self) -> &Value {
        &self.0
    }
}
pub fn decode_metadata(raw: &[u8]) -> Result<Metadata> {
    legacy_json::decode_metadata_bytes(raw)
        .map(Metadata)
        .map_err(decode_error)
}
fn decode_error(error: legacy_json::Error) -> IdentityDataError {
    match error {
        legacy_json::Error::InvalidJson => IdentityDataError::InvalidJson,
        legacy_json::Error::DuplicateKey => IdentityDataError::DuplicateKey,
    }
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
        Some(MetadataText::from_text(value.clone()))
    } else {
        None
    }
}
fn owner(value: Option<&Value>) -> Result<Option<MetadataText>> {
    match value {
        None | Some(Value(Node::Null)) => Ok(None),
        Some(Value(Node::String(value))) if value.0.len() <= 200 => {
            Ok(Some(MetadataText::from_text(value.clone())))
        }
        _ => Err(IdentityDataError::Owner),
    }
}
fn owner_matches(value: Option<&Value>, owner: &Option<MetadataText>) -> bool {
    match value {
        None | Some(Value(Node::Null)) => owner.is_none(),
        Some(value) => owner.as_ref().is_some_and(|expected| {
            value.python_eq(&Value(Node::String(Text(expected.codepoints().to_vec()))))
        }),
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
