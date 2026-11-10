//! Closed owner-local GPU intent DATA. Neither decoded intent nor a stored
//! transition document grants device access or permission to start a laptop.
mod cdi;
mod command;
mod configuration;
mod current;
mod engine;
mod native_row;
mod peers;
pub mod preflight;
mod queue;
mod status;
mod transition;
use crate::legacy_json::{Node, Number, Text, Value};
pub use cdi::{CdiDocument, CdiPreflightEdits, CdiSelectedEdits};
pub use command::{GpuCommand, GpuEmployeeSelector, decode_command};
pub use configuration::{
    GpuCandidate, applied, has_resource_actor, patch_employee_grant, private_config_matches,
};
pub use current::{GpuCurrentEmployee, current_binding, current_session};
pub use engine::{GpuEngineInformation, PreflightEndpoint, PreflightEngineData};
pub use native_row::{policy_label_matches, selected_container};
pub use peers::GpuPeerSessions;
pub use queue::{decode_requests, encode_requests};
use reverie_core::{gpu_access::GpuAccessError, operations::OperationError};
pub use status::encode_status;
use std::{collections::BTreeMap, fmt};
pub use transition::GpuTransitionIntent;

/// Same owning journal bound used by `_private`; unrelated profile/staging
/// bounds must not silently change the existing GPU queue contract.
pub const MAX_BYTES: usize = crate::operations_v1::MAX_BYTES;
pub const REQUEST_FILE: &str = "gpu-owner-requests.json";
/// Raw protected CDI artifact hash; distinct from a worker policy or control
/// domain digest and never itself a grant.
pub fn cdi_digest(raw: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    crate::digest::hex(&Sha256::digest(raw).into())
}
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, GpuDataError>;
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GpuDataError {
    Json,
    Nonfinite,
    DuplicateKey,
    RequestSchema,
    CurrentRegistry,
    CurrentEmployee,
    CurrentGeneration,
    Configuration,
    CdiDocument,
    NativeAmbiguous,
    NativeBinding,
    Core(GpuAccessError),
    Identity(OperationError),
    Control(crate::reservation_control::ControlDataError),
}
impl GpuDataError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Json => "GPU_REQUEST_JSON",
            Self::Nonfinite => "GPU_REQUEST_NONFINITE",
            Self::DuplicateKey => "GPU_REQUEST_DUPLICATE_KEY",
            Self::RequestSchema => "GPU_REQUEST_SCHEMA",
            Self::CurrentRegistry => "GPU_CURRENT_REGISTRY",
            Self::CurrentEmployee => "GPU_CURRENT_EMPLOYEE",
            Self::CurrentGeneration => "GPU_CURRENT_GENERATION",
            Self::Configuration => "GPU_CONFIG_CHANGED",
            Self::CdiDocument => "GPU_CDI_DOCUMENT",
            Self::NativeAmbiguous => "GPU_NATIVE_AMBIGUOUS",
            Self::NativeBinding => "GPU_NATIVE_BINDING",
            Self::Core(error) => error.code(),
            Self::Identity(error) => error.code(),
            Self::Control(error) => error.code(),
        }
    }
}
impl fmt::Display for GpuDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for GpuDataError {}
impl From<GpuAccessError> for GpuDataError {
    fn from(value: GpuAccessError) -> Self {
        Self::Core(value)
    }
}
impl From<OperationError> for GpuDataError {
    fn from(value: OperationError) -> Self {
        Self::Identity(value)
    }
}
impl From<crate::reservation_control::ControlDataError> for GpuDataError {
    fn from(value: crate::reservation_control::ControlDataError) -> Self {
        Self::Control(value)
    }
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn string(value: &str) -> Value {
    Value(Node::String(key(value)))
}
fn object(value: &Value) -> Option<&Object> {
    if let Node::Object(value) = &value.0 {
        Some(value)
    } else {
        None
    }
}
fn field<'a>(value: &'a Object, name: &str) -> Option<&'a Value> {
    value.get(&key(name))
}
fn exact(value: &Object, names: &[&str]) -> bool {
    value.len() == names.len() && names.iter().all(|name| value.contains_key(&key(name)))
}
fn text(value: &Value) -> Option<String> {
    if let Node::String(value) = &value.0 {
        value.0.iter().map(|&cp| char::from_u32(cp)).collect()
    } else {
        None
    }
}
fn integer(value: &Value) -> Option<&str> {
    if let Node::Number(Number::Integer(value)) = &value.0 {
        Some(value)
    } else {
        None
    }
}
fn number(value: u64) -> Value {
    Value(Node::Number(Number::Integer(value.to_string())))
}
