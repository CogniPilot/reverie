//! Exact leaseAcceptance data validation/projection. No peer process, socket,
//! mounted/kernel proof, start permission or native-effect authority is created.
mod config;
mod selection;
use crate::legacy_json::{self, Node, Number, Text, Value};
pub use config::{LeaseConfig, LeaseProjection};
use reverie_core::lease_policy::{LeaseAbsolutePath, LeasePolicyError};
pub use selection::{CurrentLeaseSession, select_company};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

/// Identifies observed peer artifact bytes only; never execution or mount proof.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeerArtifactDigest([u8; 32]);
impl PeerArtifactDigest {
    pub fn to_hex(&self) -> String {
        crate::digest::hex(&self.0)
    }
}
pub fn peer_artifact_digest(bytes: &[u8]) -> PeerArtifactDigest {
    PeerArtifactDigest(Sha256::digest(bytes).into())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseDataError {
    Json,
    DuplicateKey,
    Config,
    Option,
    Path,
    Mounts,
    Registry,
    EmployeeSelection,
    Session,
    SelectionMismatch,
    Policy(LeasePolicyError),
}
impl LeaseDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Json => "LEASE_JSON",
            Self::DuplicateKey => "DUPLICATE_KEY",
            Self::Config => "LEASE_CONFIG",
            Self::Option => "LEASE_OPTION",
            Self::Path => "LEASE_PATH",
            Self::Mounts => "LEASE_MOUNTS",
            Self::Registry => "LEASE_COMPANY_REGISTRY",
            Self::EmployeeSelection => "LEASE_EMPLOYEE_SELECTION",
            Self::Session => "LEASE_CURRENT_SESSION",
            Self::SelectionMismatch => "LEASE_SELECTION_MISMATCH",
            Self::Policy(error) => error.code(),
        }
    }
}
impl fmt::Display for LeaseDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for LeaseDataError {}
impl From<LeasePolicyError> for LeaseDataError {
    fn from(value: LeasePolicyError) -> Self {
        Self::Policy(value)
    }
}
impl From<legacy_json::Error> for LeaseDataError {
    fn from(value: legacy_json::Error) -> Self {
        match value {
            legacy_json::Error::InvalidJson => Self::Json,
            legacy_json::Error::DuplicateKey => Self::DuplicateKey,
        }
    }
}
type Result<T> = std::result::Result<T, LeaseDataError>;
type Object = BTreeMap<Text, Value>;
fn key(value: &str) -> Text {
    Text(value.bytes().map(u32::from).collect())
}
fn field<'a>(value: &'a Object, name: &str) -> Option<&'a Value> {
    value.get(&key(name))
}
fn object(value: &Value) -> Result<&Object> {
    if let Node::Object(value) = &value.0 {
        Ok(value)
    } else {
        Err(LeaseDataError::Config)
    }
}
fn text(value: Option<&Value>) -> Result<&Text> {
    if let Some(Value(Node::String(value))) = value {
        Ok(value)
    } else {
        Err(LeaseDataError::Path)
    }
}
fn absolute(value: Option<&Value>) -> Result<LeaseAbsolutePath> {
    Ok(LeaseAbsolutePath::try_new(text(value)?.0.clone())?)
}
fn uid_positive(value: Option<&Value>) -> bool {
    match value {
        Some(Value(Node::Bool(true))) | Some(Value(Node::Number(Number::PositiveInfinity))) => true,
        Some(Value(Node::Number(Number::Integer(value)))) => {
            value != "0" && !value.starts_with('-')
        }
        Some(Value(Node::Number(Number::Float(value)))) => *value > 0.0,
        _ => false,
    }
}
