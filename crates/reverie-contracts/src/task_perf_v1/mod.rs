//! Named task-v1 artifact and projection data, never host or effect authority.
mod config;
mod manifest;
mod producer;
mod profile;

pub use config::{TaskPerfConfiguration, TaskPerfProjection};
pub use manifest::{PerfSystem, TaskPerfManifest};
pub use producer::{TaskPerfProducedBytes, produce_task_perf};
pub use profile::{TaskPerfArtifactData, TaskPerfProfile};

use crate::legacy_json::{self, Node, Text, Value};
use reverie_core::task_perf::TaskPerfPolicyError;
use std::collections::BTreeMap;
use std::fmt;

pub const MAX_ARTIFACT_BYTES: usize = 65_536;
pub const MARKER: &str = "_taskPerfPolicy";
const MANIFEST_PURPOSE: &str = "worker-task-perf-profile-v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskPerfError {
    Json,
    DuplicateKey,
    ArtifactBound,
    Manifest,
    System,
    Path,
    Digest,
    DefaultDeny,
    AlreadyApplied,
    Derivative,
    PolicyMap,
    Policy(TaskPerfPolicyError),
    FixedArtifactRequired,
    FixedBaseRequired,
    Marker,
}
impl TaskPerfError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Json => "TASK_PERF_JSON",
            Self::DuplicateKey => "DUPLICATE_KEY",
            Self::ArtifactBound => "TASK_PERF_ARTIFACT_BOUND",
            Self::Manifest => "TASK_PERF_MANIFEST",
            Self::System => "TASK_PERF_SYSTEM",
            Self::Path => "TASK_PERF_NIX_PATH",
            Self::Digest => "TASK_PERF_ARTIFACT_DIGEST",
            Self::DefaultDeny => "TASK_PERF_DEFAULT_DENY_REQUIRED",
            Self::AlreadyApplied => "TASK_PERF_ALREADY_APPLIED",
            Self::Derivative => "TASK_PERF_DERIVATIVE",
            Self::PolicyMap => "TASK_PERF_POLICY_MAP",
            Self::Policy(error) => error.code(),
            Self::FixedArtifactRequired => "TASK_PERF_FIXED_ARTIFACT_REQUIRED",
            Self::FixedBaseRequired => "TASK_PERF_FIXED_BASE_REQUIRED",
            Self::Marker => "TASK_PERF_SELECTION_MARKER",
        }
    }
}
impl fmt::Display for TaskPerfError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for TaskPerfError {}
impl From<legacy_json::Error> for TaskPerfError {
    fn from(error: legacy_json::Error) -> Self {
        match error {
            legacy_json::Error::InvalidJson => Self::Json,
            legacy_json::Error::DuplicateKey => Self::DuplicateKey,
        }
    }
}
impl From<TaskPerfPolicyError> for TaskPerfError {
    fn from(error: TaskPerfPolicyError) -> Self {
        Self::Policy(error)
    }
}
type Result<T> = std::result::Result<T, TaskPerfError>;
fn key(text: &str) -> Text {
    Text(text.chars().map(u32::from).collect())
}
fn string(value: &Value) -> Option<String> {
    match &value.0 {
        Node::String(text) => text
            .0
            .iter()
            .map(|&codepoint| char::from_u32(codepoint))
            .collect(),
        _ => None,
    }
}
fn object(value: &Value) -> Option<&BTreeMap<Text, Value>> {
    match &value.0 {
        Node::Object(fields) => Some(fields),
        _ => None,
    }
}
fn scalar(text: &str) -> Value {
    Value(Node::String(key(text)))
}
fn bounded_json(raw: &[u8]) -> Result<Value> {
    if raw.len() > MAX_ARTIFACT_BYTES {
        return Err(TaskPerfError::ArtifactBound);
    }
    Ok(legacy_json::decode_bytes(raw)?)
}
