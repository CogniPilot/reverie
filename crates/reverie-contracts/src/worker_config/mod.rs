//! Legacy effective-worker JSON bytes, with Python's default spaces and ASCII.
//! Inputs are projected data, never evidence of validation, readiness or authority.
mod encode;

use crate::legacy_json::{self, Node, Text, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

pub fn decode(raw: &[u8]) -> Result<EffectiveWorkerConfig, WorkerConfigError> {
    std::str::from_utf8(raw).map_err(|_| WorkerConfigError::InvalidJson)?;
    let value = legacy_json::decode_utf8(raw).map_err(|error| match error {
        legacy_json::Error::InvalidJson => WorkerConfigError::InvalidJson,
        legacy_json::Error::DuplicateKey => WorkerConfigError::DuplicateKey,
    })?;
    if !matches!(value.0, Node::Object(_)) {
        return Err(WorkerConfigError::ExpectedObject);
    }
    Ok(EffectiveWorkerConfig(value))
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
pub struct EffectiveWorkerConfig(Value);
impl EffectiveWorkerConfig {
    pub(crate) fn as_value(&self) -> &Value {
        &self.0
    }
    pub(crate) fn into_value(self) -> Value {
        self.0
    }
    pub(crate) fn from_object(value: BTreeMap<Text, Value>) -> Self {
        Self(Value(Node::Object(value)))
    }
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
