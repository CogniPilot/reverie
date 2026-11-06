//! Original source-runtime baseline DATA. This cannot mint a retained claim,
//! process birth, source-stop permission, preparation owner or launch permit.
mod accounts;
use crate::{
    legacy_json::{Node, Text, Value},
    reservation_engine::{ContainerRow, NativeLimitBinding, NativeStorageBinding},
    storage_identity::MetadataText,
};
pub use accounts::{AccountDeclaration, AccountDeclarations, ObservedAccount};
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath};
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BaselineDataError {
    Account,
    Source,
    Capacity,
    Fingerprint,
}
impl BaselineDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Account => "RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED",
            Self::Source => "RESOURCE_NATIVE_SOURCE_CHANGED",
            Self::Capacity => "RESOURCE_NATIVE_CAPACITY_CHANGED",
            Self::Fingerprint => "RESOURCE_NATIVE_BASELINE_FINGERPRINT",
        }
    }
}
impl fmt::Display for BaselineDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for BaselineDataError {}
type Result<T> = std::result::Result<T, BaselineDataError>;
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn field<'a>(value: &'a Object, name: &str) -> Option<&'a Value> {
    value.get(&key(name))
}
fn text(value: Option<&Value>) -> Result<&Text> {
    match value {
        Some(Value(Node::String(value))) => Ok(value),
        _ => Err(BaselineDataError::Account),
    }
}
fn object(value: &Value) -> Result<&Object> {
    match &value.0 {
        Node::Object(value) => Ok(value),
        _ => Err(BaselineDataError::Account),
    }
}
fn need(value: bool, error: BaselineDataError) -> Result<()> {
    if value { Ok(()) } else { Err(error) }
}
fn integer(value: u64) -> Value {
    Value(Node::Number(crate::legacy_json::Number::Integer(
        value.to_string(),
    )))
}

/// Final fixed-kernel account/cgroup observations, distinct from any permission
/// or held descriptor. Installing application code retains its actual source.
#[derive(Clone)]
pub struct OriginalRuntimeTail {
    group: [u64; 2],
    accounts: Vec<ObservedAccount>,
}
impl OriginalRuntimeTail {
    pub fn from_observed_data(group: [u64; 2], accounts: Vec<ObservedAccount>) -> Self {
        Self { group, accounts }
    }
    pub fn cgroup_identity(&self) -> [u64; 2] {
        self.group
    }
    pub fn accounts(&self) -> &[ObservedAccount] {
        &self.accounts
    }
}
pub struct OriginalBaselineFields<'a> {
    pub source: &'a ContainerRow,
    pub native: &'a NativeLimitBinding,
    pub storage: &'a NativeStorageBinding,
    pub site: &'a NativeLimitBinding,
    pub commitments: &'a [NativeLimitBinding],
    pub total: &'a UnsignedInteger,
    pub budget: &'a UnsignedInteger,
    pub runtime: &'a OriginalRuntimeTail,
}
/// Complete original capture_original dictionary. Construction retains unknown
/// row fields/nonfinite extras as DATA; finite serialization happens only at its
/// later actual receipt/hash phase, as in the original workflow.
pub struct OriginalSourceBaseline {
    value: Value,
    source: reverie_core::ids::ContainerId,
}
impl OriginalSourceBaseline {
    pub fn source_container(&self) -> &reverie_core::ids::ContainerId {
        &self.source
    }
    pub(crate) fn data(&self) -> &Value {
        &self.value
    }
    pub fn from_observed_data(fields: OriginalBaselineFields<'_>) -> Self {
        let scalar = |value: &UnsignedInteger| {
            Value(Node::Number(crate::legacy_json::Number::Integer(
                value.as_str().to_owned(),
            )))
        };
        let array =
            |values: &[u64]| Value(Node::Array(values.iter().copied().map(integer).collect()));
        let accounts = fields
            .runtime
            .accounts
            .iter()
            .map(|account| {
                Value(Node::Object(
                    [
                        (
                            key("source"),
                            Value(Node::String(Text(account.source().codepoints().to_vec()))),
                        ),
                        (
                            key("destination"),
                            Value(Node::String(Text(
                                account.destination().codepoints().to_vec(),
                            ))),
                        ),
                        (key("identity"), array(&account.identity())),
                    ]
                    .into_iter()
                    .collect(),
                ))
            })
            .collect();
        let value = Value(Node::Object(
            [
                (
                    key("schema"),
                    Value(Node::String(key("reverie-resource-native-baseline-v1"))),
                ),
                (key("sourceRow"), fields.source.data().deep_clone()),
                (key("native"), fields.native.data().deep_clone()),
                (key("storage"), fields.storage.data().deep_clone()),
                (key("site"), fields.site.data().deep_clone()),
                (
                    key("commitments"),
                    Value(Node::Array(
                        fields
                            .commitments
                            .iter()
                            .map(|binding| binding.data().deep_clone())
                            .collect(),
                    )),
                ),
                (key("cgroupIdentity"), array(&fields.runtime.group)),
                (key("total"), scalar(fields.total)),
                (key("budget"), scalar(fields.budget)),
                (key("accounts"), Value(Node::Array(accounts))),
            ]
            .into_iter()
            .collect(),
        ));
        Self {
            value,
            source: fields.source.id().clone(),
        }
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        crate::reservation_control::fingerprint(&self.value)
            .map_err(|_| BaselineDataError::Fingerprint)?;
        Ok(crate::worker_config::compact_data(&self.value))
    }
}
