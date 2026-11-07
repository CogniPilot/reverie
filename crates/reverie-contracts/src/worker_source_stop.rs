//! Original immutable-CID stop inspection DATA. No decoded value grants an
//! effect, source lease, completed stop or permission to release a resource.
use crate::{
    legacy_json::{self, Node, Text, Value},
    reservation_baseline::OriginalSourceBaseline,
    worker_config::WorkerPolicyDigest,
};
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ContainerId, ProfileSessionId},
    worker_laptop::WorkerContainerName,
    worker_schema::WorkerBase,
};
use std::collections::BTreeMap;
mod ordinary;
pub use ordinary::{
    OrdinaryContainer, OrdinaryNetwork, ordinary_container_absent, ordinary_network_absent,
};
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, SourceStopDataError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceStopDataError {
    Json,
    Name,
    Identity,
    State,
    ReleasedState,
    Metadata,
}
impl std::fmt::Display for SourceStopDataError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl SourceStopDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Json => "SOURCE_STOP_JSON",
            Self::Name => "Exact owned laptop identity required",
            Self::Identity => "Exact owned laptop identity changed",
            Self::State => "Exact owned laptop state is unavailable",
            Self::ReleasedState => "Exact source laptop state is unavailable",
            Self::Metadata => "Exact source laptop metadata changed",
        }
    }
}
impl std::error::Error for SourceStopDataError {}
fn key(name: &str) -> Text {
    Text(name.chars().map(u32::from).collect())
}
fn object(value: &Value) -> Option<&Object> {
    if let Node::Object(fields) = &value.0 {
        Some(fields)
    } else {
        None
    }
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    object(value)?.get(&key(name))
}
fn matches(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value(Node::String(value))) if value.equals_ascii(expected))
}
fn row(raw: &[u8]) -> Result<Value> {
    let mut value = legacy_json::decode_python_str(raw).map_err(|_| SourceStopDataError::Json)?;
    let Node::Array(rows) = &mut value.0 else {
        return Err(SourceStopDataError::Identity);
    };
    if rows.len() != 1 || object(&rows[0]).is_none() {
        return Err(SourceStopDataError::Identity);
    }
    Ok(rows.remove(0))
}
/// Exact raw baseline name, with only Python's single leading '/' removed.
/// Legacy bare-SID recovery membership cannot redirect this to a canonical name.
pub struct SourceStopName {
    name: WorkerContainerName,
    session: ProfileSessionId,
    container: ContainerId,
    native: crate::reservation_engine::NativeLimitBinding,
}
impl SourceStopName {
    pub fn from_baseline(base: &WorkerBase, baseline: &OriginalSourceBaseline) -> Result<Self> {
        let raw = field(baseline.data(), "sourceRow").and_then(|row| field(row, "Name"));
        let Some(Value(Node::String(text))) = raw else {
            return Err(SourceStopDataError::Name);
        };
        let points = text.0.strip_prefix(&[47]).unwrap_or(&text.0);
        let name = points
            .iter()
            .copied()
            .map(char::from_u32)
            .collect::<Option<String>>()
            .ok_or(SourceStopDataError::Name)?;
        let prefix = format!("{}-agent-", base.deployment());
        if !name.starts_with(&prefix) {
            return Err(SourceStopDataError::Name);
        }
        let (session, name) = WorkerContainerName::from_recovered_name_data(base, &name)
            .ok_or(SourceStopDataError::Name)?;
        Ok(Self {
            name,
            session,
            container: baseline.source_container().clone(),
            native: baseline.native().clone(),
        })
    }
    pub fn name(&self) -> &WorkerContainerName {
        &self.name
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn container(&self) -> &ContainerId {
        &self.container
    }
    pub fn native(&self) -> &crate::reservation_engine::NativeLimitBinding {
        &self.native
    }
}
pub struct SourceStopInspection(Value);
impl SourceStopInspection {
    /// Call after the actual inspect. Policy resolution deliberately occurs
    /// LATER, only after these original Id/Name/worker/session checks succeed.
    pub fn identity(
        raw: &[u8],
        name: &SourceStopName,
        expected: &ContainerId,
        deployment: &str,
    ) -> Result<Self> {
        Self::identity_for_worker(raw, name.name(), name.session(), expected, deployment)
    }
    /// Shared exact identity decoder for protected and ordinary observations.
    /// Checked names and decoded metadata are DATA, never a stop capability.
    pub fn identity_for_worker(
        raw: &[u8],
        name: &WorkerContainerName,
        session: &ProfileSessionId,
        expected: &ContainerId,
        deployment: &str,
    ) -> Result<Self> {
        let row = row(raw)?;
        let labels = field(&row, "Config").and_then(|value| field(value, "Labels"));
        if !matches(field(&row, "Id"), expected.as_str())
            || !matches(field(&row, "Name"), &format!("/{}", name.as_str()))
            || !matches(
                labels.and_then(|value| field(value, "reverie.worker")),
                deployment,
            )
            || !matches(
                labels.and_then(|value| field(value, "reverie.session")),
                session.as_str(),
            )
        {
            return Err(SourceStopDataError::Identity);
        }
        Ok(Self(row))
    }
    pub fn assert_policy(&self, expected: &WorkerPolicyDigest) -> Result<()> {
        let labels = field(&self.0, "Config").and_then(|value| field(value, "Labels"));
        if matches(
            labels.and_then(|value| field(value, "reverie.worker-policy")),
            &expected.to_hex(),
        ) {
            Ok(())
        } else {
            Err(SourceStopDataError::Identity)
        }
    }
    pub fn state(&self) -> Result<SourceStopState> {
        state(&self.0)
    }
    /// Projection happens after the original separate process observations.
    pub fn metadata(&self) -> SourceStopMetadata {
        SourceStopMetadata(metadata(&self.0))
    }
}
pub struct SourceStopState {
    running: bool,
    pid: UnsignedInteger,
}
impl SourceStopState {
    pub fn running(&self) -> bool {
        self.running
    }
    pub fn pid(&self) -> &UnsignedInteger {
        &self.pid
    }
}
fn state(row: &Value) -> Result<SourceStopState> {
    let state = field(row, "State").ok_or(SourceStopDataError::State)?;
    let Some(Value(Node::Bool(running))) = field(state, "Running") else {
        return Err(SourceStopDataError::State);
    };
    let Some(Value(Node::Number(legacy_json::Number::Integer(pid)))) = field(state, "Pid") else {
        return Err(SourceStopDataError::State);
    };
    let pid = UnsignedInteger::parse(pid).ok_or(SourceStopDataError::State)?;
    if *running == pid.is_zero() {
        return Err(SourceStopDataError::State);
    }
    Ok(SourceStopState {
        running: *running,
        pid,
    })
}
fn metadata(row: &Value) -> Value {
    Value(Node::Object(
        ["Id", "Name", "Image", "Config", "HostConfig", "Mounts"]
            .map(|name| {
                (
                    key(name),
                    field(row, name).map_or(Value(Node::Null), Value::deep_clone),
                )
            })
            .into_iter()
            .collect(),
    ))
}
pub struct SourceStopMetadata(Value);
impl SourceStopMetadata {
    pub fn observe(&self, raw: &[u8], succeeded: bool) -> Result<SourceStopState> {
        if !succeeded {
            return Err(SourceStopDataError::Metadata);
        }
        let row = row(raw)?;
        if !metadata(&row).python_eq(&self.0) {
            return Err(SourceStopDataError::Metadata);
        }
        state(&row).map_err(|error| {
            if error == SourceStopDataError::State {
                SourceStopDataError::ReleasedState
            } else {
                error
            }
        })
    }
}
