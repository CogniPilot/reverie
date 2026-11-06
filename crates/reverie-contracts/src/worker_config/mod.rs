//! Legacy effective-worker JSON bytes, with Python's default spaces and ASCII.
//! Inputs are projected data, never evidence of validation, readiness or authority.
mod encode;

use crate::legacy_json::{self, Node, Text, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

pub fn decode(raw: &[u8]) -> Result<EffectiveWorkerConfig, WorkerConfigError> {
    std::str::from_utf8(raw).map_err(|_| WorkerConfigError::InvalidJson)?;
    let value = legacy_json::decode_ordered_utf8(raw).map_err(|error| match error {
        legacy_json::Error::InvalidJson => WorkerConfigError::InvalidJson,
        legacy_json::Error::DuplicateKey => WorkerConfigError::DuplicateKey,
    })?;
    EffectiveWorkerConfig::from_ordered(value)
}

/// Path.read_text() followed by default json.loads(str), for the named owner
/// loader only. Keep last-wins/4300-digit/nonfinite behavior separate from the
/// duplicate-free captured hash codec and byte-encoding auto-detection readers.
pub fn decode_owner_text(raw: &[u8]) -> Result<EffectiveWorkerConfig, WorkerConfigError> {
    let text = std::str::from_utf8(raw).map_err(|_| WorkerConfigError::InvalidJson)?;
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let value = legacy_json::decode_python_str_ordered(text.as_bytes())
        .map_err(|_| WorkerConfigError::InvalidJson)?;
    EffectiveWorkerConfig::from_ordered(value)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerConfigError {
    InvalidJson,
    DuplicateKey,
    ExpectedObject,
}
impl WorkerConfigError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidJson => "WORKER_CONFIG_JSON",
            Self::DuplicateKey => "DUPLICATE_KEY",
            Self::ExpectedObject => "WORKER_CONFIG_OBJECT",
        }
    }
}
impl fmt::Display for WorkerConfigError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for WorkerConfigError {}

/// A duplicate-free Python JSON object supplied as an already projected worker
/// configuration. This codec does not validate the worker schema or resolve any
/// GPU/perf/memory/storage/lease facts; its name identifies the legacy hash format.
/// Legacy nonfinite data spellings are preserved here, not admitted into resource
/// policy types or strict wire schemas.
pub struct EffectiveWorkerConfig(Value, Vec<crate::storage_identity::MetadataText>);
impl Clone for EffectiveWorkerConfig {
    fn clone(&self) -> Self {
        Self(self.0.deep_clone(), self.1.clone())
    }
}
impl EffectiveWorkerConfig {
    pub(crate) fn patch_employee_gpu_grant(
        &mut self,
        employee: &reverie_core::operations::JournalId,
        device: Option<&reverie_core::gpu_access::GpuDeviceUuid>,
    ) -> Option<()> {
        let Node::Object(root) = &mut self.0.0 else {
            unreachable!("worker object invariant");
        };
        let name = Text("employeeGpuGrants".chars().map(u32::from).collect());
        let grants = root
            .entry(name)
            .or_insert_with(|| Value(Node::Object(BTreeMap::new())));
        let Node::Object(grants) = &mut grants.0 else {
            return None;
        };
        let employee = Text(employee.as_str().chars().map(u32::from).collect());
        if let Some(device) = device {
            grants.insert(
                employee,
                Value(Node::String(Text(
                    device.device().as_str().chars().map(u32::from).collect(),
                ))),
            );
        } else {
            grants.remove(&employee);
        }
        Some(())
    }
    fn from_ordered(value: legacy_json::ordered::OrderedValue) -> Result<Self, WorkerConfigError> {
        if !matches!(value.value.0, Node::Object(_)) {
            return Err(WorkerConfigError::ExpectedObject);
        }
        let name = Text("sessionResources".chars().map(u32::from).collect());
        let order = value
            .root_child_index(&name)
            .and_then(|index| value.graph.nodes.get(index));
        let order = match order {
            Some(legacy_json::ordered::OrderNode::Object(keys)) => keys
                .iter()
                .map(|(key, _)| crate::storage_identity::MetadataText::from_text(key.clone()))
                .collect(),
            _ => Vec::new(),
        };
        Ok(Self(value.value, order))
    }
    /// Original configured session-map iteration order for named native peer
    /// checks. It is DATA, not a trusted SID list, validation or a capability.
    pub fn session_resource_order(&self) -> &[crate::storage_identity::MetadataText] {
        &self.1
    }
    pub(crate) fn as_value(&self) -> &Value {
        &self.0
    }
    pub(crate) fn into_value(self) -> Value {
        self.0
    }
    pub(crate) fn from_object(value: BTreeMap<Text, Value>) -> Self {
        let name = Text("sessionResources".chars().map(u32::from).collect());
        let order = match value.get(&name) {
            Some(Value(Node::Object(keys))) => keys
                .keys()
                .cloned()
                .map(crate::storage_identity::MetadataText::from_text)
                .collect(),
            _ => Vec::new(),
        };
        Self(Value(Node::Object(value)), order)
    }
}
/// Python dictionary equality for captured configuration DATA, distinct from
/// byte/digest identity and never an authorization or applied-config receipt.
pub fn equivalent(left: &EffectiveWorkerConfig, right: &EffectiveWorkerConfig) -> bool {
    left.0.python_eq(&right.0)
}
/// Exact Broker.handle image-refresh comparison: {**current,image:loaded.image}
/// == loaded, using Python container/numeric equality. This is DATA comparison,
/// never a loaded-file/native/start approval or a generic configuration editor.
pub fn image_only_equivalent(
    current: &EffectiveWorkerConfig,
    loaded: &EffectiveWorkerConfig,
) -> bool {
    let Node::Object(after) = &loaded.as_value().0 else {
        unreachable!("worker object");
    };
    let name = Text("image".chars().map(u32::from).collect());
    let Some(image) = after.get(&name) else {
        return false;
    };
    let mut before = current.as_value().deep_clone();
    let Node::Object(before_fields) = &mut before.0 else {
        unreachable!("worker object");
    };
    before_fields.insert(name, image.deep_clone());
    before.python_eq(loaded.as_value())
}

/// Python json.dumps(effective_config, sort_keys=True).encode(), including all keys.
pub fn encode_config(config: &EffectiveWorkerConfig) -> Vec<u8> {
    encode_data(&config.0)
}
pub(crate) fn encode_data(value: &Value) -> Vec<u8> {
    encode::encode(value, false)
}
pub(crate) fn compact_data(value: &Value) -> Vec<u8> {
    encode::compact(value)
}
pub(crate) fn quoted_text(
    text: &crate::legacy_json::Text,
    ascii: bool,
) -> crate::legacy_json::Text {
    encode::quoted_text(text, ascii)
}
/// Excludes only top-level image, maintenanceSessions and opsConfig.
pub fn encode_policy(config: &EffectiveWorkerConfig) -> Vec<u8> {
    encode::encode(&config.0, true)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerConfigDigest([u8; 32]);
impl WorkerConfigDigest {
    pub fn to_hex(&self) -> String {
        crate::digest::hex(&self.0)
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerPolicyDigest([u8; 32]);
impl WorkerPolicyDigest {
    pub fn to_hex(&self) -> String {
        crate::digest::hex(&self.0)
    }
}
pub fn config_digest(config: &EffectiveWorkerConfig) -> WorkerConfigDigest {
    WorkerConfigDigest(Sha256::digest(encode_config(config)).into())
}
pub fn policy_digest(config: &EffectiveWorkerConfig) -> WorkerPolicyDigest {
    WorkerPolicyDigest(Sha256::digest(encode_policy(config)).into())
}
