//! Existing host-job intent/settlement DATA. Parsing or a historical receipt
//! cannot create an owned scope, live process binding, settlement or permission.
mod dictionary;
mod spec;
use crate::{
    legacy_json::{Node, Text, Value},
    reservation_control::ControlDomainDigest,
    storage_identity::{Metadata, MetadataText, OrderedMetadata},
};
use reverie_core::{
    host_scope::{HostJobId, HostScopeError, HostScopeLimits},
    operations::{JournalDigest, OperationScope},
};
pub use spec::{HostJobPath, HostJobSpecData};
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostJobDataError {
    Outcome,
    Spec,
    FixedScope,
    PolicyDigest,
    SourceDigest,
    Core(HostScopeError),
    Receipt,
    Fingerprint,
}
impl HostJobDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Outcome => "HOST_JOB_OUTCOME_REQUIRES_PROTECTED_RECONCILIATION",
            Self::Spec => "FIXED_HOST_JOB_SPEC_REQUIRED",
            Self::FixedScope => "FIXED_JOB_SCOPE",
            Self::PolicyDigest => "POLICY_DIGEST",
            Self::SourceDigest => "SOURCE_DIGEST",
            Self::Core(error) => error.code(),
            Self::Receipt => "HOST_JOB_SETTLEMENT_RECEIPT_CHANGED",
            Self::Fingerprint => "HOST_JOB_FINGERPRINT",
        }
    }
}
impl fmt::Display for HostJobDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for HostJobDataError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Core(error) => Some(error),
            _ => None,
        }
    }
}
impl From<HostScopeError> for HostJobDataError {
    fn from(error: HostScopeError) -> Self {
        Self::Core(error)
    }
}
type Result<T> = std::result::Result<T, HostJobDataError>;
pub struct HostJobIntent {
    spec: HostJobSpecData,
    original_spec: Value,
    settlement: Value,
}
impl HostJobIntent {
    /// Existing require_idle's first data phase. Path resolution remains a real
    /// host read before the selected settlement receipt may be read/qualified.
    pub fn capture(
        metadata: &OrderedMetadata,
        scope: &OperationScope,
        domain: &ControlDomainDigest,
    ) -> Result<Self> {
        let document = metadata.ordered();
        let root = object(&document.value, HostJobDataError::Outcome)?;
        exact(
            root,
            &[
                "schema",
                "state",
                "scope",
                "spec",
                "configurationDigest",
                "settlementDigest",
            ],
            HostJobDataError::Outcome,
        )?;
        let scope_value = Value(Node::Object(
            [
                (key("company_id"), text_value(scope.company_id.as_str())),
                (
                    key("owner_scope_digest"),
                    text_value(scope.owner_scope_digest.as_str()),
                ),
            ]
            .into_iter()
            .collect(),
        ));
        let ready = equals(field(root, "schema")?, "reverie-host-job-intent-v1")
            && field(root, "scope")?.python_eq(&scope_value)
            && equals(field(root, "configurationDigest")?, &domain.to_hex())
            && equals(field(root, "state")?, "SETTLED_NATIVE");
        if !ready {
            return Err(HostJobDataError::Outcome);
        }
        let original_spec = field(root, "spec")?;
        let index = document
            .root_child_index(&key("spec"))
            .ok_or(HostJobDataError::Spec)?;
        let values = dictionary::capture(original_spec, &document.graph, index)?;
        let spec = HostJobSpecData::capture(&values)?;
        Ok(Self {
            spec,
            original_spec: original_spec.deep_clone(),
            settlement: field(root, "settlementDigest")?.deep_clone(),
        })
    }
    pub fn spec(&self) -> &HostJobSpecData {
        &self.spec
    }
    pub fn assert_receipt(&self, metadata: &Metadata) -> Result<()> {
        let value = metadata.as_value();
        let digest = crate::reservation_control::fingerprint(value)
            .map_err(|_| HostJobDataError::Fingerprint)?;
        let hash = crate::digest::hex(&digest);
        if !equals(&self.settlement, &hash) {
            return Err(HostJobDataError::Receipt);
        }
        let receipt = object(value, HostJobDataError::Receipt)?;
        if !receipt
            .get(&key("kind"))
            .is_some_and(|value| equals(value, "OBSERVED_HOST_SCOPE_SETTLED"))
            || !receipt
                .get(&key("spec"))
                .is_some_and(|value| value.python_eq(&self.original_spec))
        {
            return Err(HostJobDataError::Receipt);
        }
        Ok(())
    }
}
fn key(text: &str) -> Text {
    Text(text.chars().map(u32::from).collect())
}
fn text_value(text: &str) -> Value {
    Value(Node::String(key(text)))
}
fn equals(value: &Value, text: &str) -> bool {
    matches!(&value.0,Node::String(value) if value.equals_ascii(text))
}
fn object(value: &Value, error: HostJobDataError) -> Result<&Object> {
    if let Node::Object(fields) = &value.0 {
        Ok(fields)
    } else {
        Err(error)
    }
}
fn field<'a>(object: &'a Object, name: &str) -> Result<&'a Value> {
    object.get(&key(name)).ok_or(HostJobDataError::Spec)
}
fn exact(object: &Object, keys: &[&str], error: HostJobDataError) -> Result<()> {
    if object.len() == keys.len() && keys.iter().all(|name| object.contains_key(&key(name))) {
        Ok(())
    } else {
        Err(error)
    }
}
