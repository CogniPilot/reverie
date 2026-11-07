//! The actual Broker._reload_resources inspection DATA checks. This reader
//! retains normal json.loads(str) last-wins/4300/nonfinite behavior and defers
//! Config/Labels and effective-policy reads until Running is Python-truthy.
use crate::{
    legacy_json::{self, Node, Text, Value},
    worker_config::WorkerPolicyDigest,
};
use reverie_core::ids::ProfileSessionId;
use std::{collections::BTreeMap, fmt};
mod launch;
pub use launch::LaunchLaptopInspection;
type Object = BTreeMap<Text, Value>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaptopReadError {
    Json,
    Structure,
    Policy,
    Ownership,
}
impl LaptopReadError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Json => "WORKER_LAPTOP_INSPECTION_JSON",
            Self::Structure => "WORKER_LAPTOP_INSPECTION_STRUCTURE",
            Self::Policy => "WORKER_LAPTOP_LIVE_POLICY_CHANGED",
            Self::Ownership => "WORKER_LAPTOP_FOREIGN_DEPLOYMENT",
        }
    }
}
impl fmt::Display for LaptopReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for LaptopReadError {}
pub struct BrokerLaptopInspection(Value);
pub struct RunningLaptop<'a> {
    labels: Option<&'a Object>,
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, LaptopReadError> {
    let Node::Object(value) = &value.0 else {
        return Err(LaptopReadError::Structure);
    };
    value.get(&key(name)).ok_or(LaptopReadError::Structure)
}
fn label(labels: Option<&Object>, name: &str, wanted: &str) -> bool {
    matches!(labels.and_then(|labels|labels.get(&key(name))),Some(Value(Node::String(value))) if value.equals_ascii(wanted))
}
impl BrokerLaptopInspection {
    pub fn decode(stdout: &[u8]) -> Result<Self, LaptopReadError> {
        first(stdout).map(Self)
    }
    pub fn running_identity(
        &self,
        deployment: &str,
        session: &ProfileSessionId,
    ) -> Result<Option<RunningLaptop<'_>>, LaptopReadError> {
        if !legacy_json::truthy(Some(field(field(&self.0, "State")?, "Running")?)) {
            return Ok(None);
        }
        let labels = field(field(&self.0, "Config")?, "Labels")?;
        let labels = if legacy_json::truthy(Some(labels)) {
            let Node::Object(labels) = &labels.0 else {
                return Err(LaptopReadError::Structure);
            };
            Some(labels)
        } else {
            None
        };
        if !label(labels, "reverie.worker", deployment)
            || !label(labels, "reverie.session", session.as_str())
        {
            return Err(LaptopReadError::Policy);
        }
        Ok(Some(RunningLaptop { labels }))
    }
}
fn first(stdout: &[u8]) -> Result<Value, LaptopReadError> {
    let mut value = legacy_json::decode_python_str(stdout).map_err(|_| LaptopReadError::Json)?;
    let Node::Array(values) = &mut value.0 else {
        return Err(LaptopReadError::Structure);
    };
    if values.is_empty() {
        return Err(LaptopReadError::Structure);
    }
    // Only [0] is consumed in the source. Unknown/extra returned rows are
    // parsed completely but do not acquire extra identity requirements.
    Ok(std::mem::replace(&mut values[0], Value(Node::Null)))
}
impl RunningLaptop<'_> {
    pub fn assert_policy(&self, expected: &WorkerPolicyDigest) -> Result<(), LaptopReadError> {
        if label(self.labels, "reverie.worker-policy", &expected.to_hex()) {
            Ok(())
        } else {
            Err(LaptopReadError::Policy)
        }
    }
}
