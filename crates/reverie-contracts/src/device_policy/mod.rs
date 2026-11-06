//! Named GPU and soft-memory data projections, not owner or effect authority.
pub mod gpu;
pub mod memory;
use crate::legacy_json::{Node, Number, Text, Value};
use crate::worker_config::EffectiveWorkerConfig;
use reverie_core::{ValueError, device_policy::DevicePolicyError};
use std::collections::BTreeMap;
use std::fmt;

type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, DeviceConfigError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceConfigError {
    Json,
    DuplicateKey,
    GpuShape,
    MemoryShape,
    CurrentEmployeeMismatch,
    EffectiveCeilingMismatch,
    Identity(ValueError),
    Policy(DevicePolicyError),
}
impl DeviceConfigError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Json => "DEVICE_POLICY_JSON",
            Self::DuplicateKey => "DUPLICATE_KEY",
            Self::GpuShape => "GPU_GRANT_MAP",
            Self::MemoryShape => "EMPLOYEE_MEMORY_POLICY_SHAPE",
            Self::CurrentEmployeeMismatch => "CURRENT_GPU_EMPLOYEE_SESSION",
            Self::EffectiveCeilingMismatch => "EFFECTIVE_RAM_BINDING",
            Self::Identity(error) => error.code(),
            Self::Policy(error) => error.code(),
        }
    }
}
impl From<ValueError> for DeviceConfigError {
    fn from(value: ValueError) -> Self {
        Self::Identity(value)
    }
}
impl From<DevicePolicyError> for DeviceConfigError {
    fn from(value: DevicePolicyError) -> Self {
        Self::Policy(value)
    }
}
impl fmt::Display for DeviceConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for DeviceConfigError {}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn object(value: &Value) -> Option<&Object> {
    if let Node::Object(value) = &value.0 {
        Some(value)
    } else {
        None
    }
}
fn root(config: &EffectiveWorkerConfig) -> &Object {
    object(config.as_value()).expect("worker object invariant")
}
fn take_root(config: EffectiveWorkerConfig) -> Object {
    let mut value = config.into_value();
    let Node::Object(root) = std::mem::replace(&mut value.0, Node::Null) else {
        unreachable!("worker object invariant");
    };
    root
}
fn text(value: &Text) -> Result<String> {
    value
        .0
        .iter()
        .map(|&cp| char::from_u32(cp))
        .collect::<Option<_>>()
        .ok_or(DeviceConfigError::GpuShape)
}
fn integer(value: Option<&Value>) -> Result<u32> {
    match value {
        Some(Value(Node::Number(Number::Integer(value)))) => {
            value.parse().map_err(|_| DeviceConfigError::MemoryShape)
        }
        _ => Err(DeviceConfigError::MemoryShape),
    }
}
fn integer_value(value: u32) -> Value {
    Value(Node::Number(Number::Integer(value.to_string())))
}
