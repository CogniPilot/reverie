use super::{
    MARKER, Result, TaskPerfArtifactData, TaskPerfError, TaskPerfProfile, key, object, scalar,
    string,
};
use crate::legacy_json::{self, Node, Value};
use crate::worker_config::EffectiveWorkerConfig;
use reverie_core::ids::ProfileEmployeeId;
use reverie_core::task_perf::{
    MAX_PERF_EMPLOYEES, TaskPerfPolicies, TaskPerfPolicy, TaskPerfPolicyError,
};
use std::collections::BTreeMap;

/// Only the perf domain is validated here. Other fields remain lossless data;
/// this is not a complete worker configuration or an authorization context.
pub struct TaskPerfConfiguration {
    value: Value,
    policies: TaskPerfPolicies,
}
impl TaskPerfConfiguration {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        std::str::from_utf8(raw).map_err(|_| TaskPerfError::Json)?;
        Self::from_value(legacy_json::decode_utf8(raw)?)
    }
    /// Move already captured data into this feature without a JSON round trip.
    pub fn capture(config: EffectiveWorkerConfig) -> Result<Self> {
        Self::from_value(config.into_value())
    }
    /// resource_config applies perf to its already projected resources, with
    /// only the original employeePerfPolicies control key temporarily restored.
    pub fn for_resources(
        source: &EffectiveWorkerConfig,
        resources: EffectiveWorkerConfig,
    ) -> Result<Self> {
        let mut value = resources.into_value();
        let Node::Object(fields) = &mut value.0 else {
            unreachable!("worker object invariant");
        };
        if let Some(policies) =
            object(source.as_value()).and_then(|source| source.get(&key("employeePerfPolicies")))
        {
            fields.insert(key("employeePerfPolicies"), policies.deep_clone());
        }
        Self::from_value(value)
    }
    fn from_value(value: Value) -> Result<Self> {
        let policies = Self::validate_value(&value)?;
        Ok(Self { value, policies })
    }
    /// Borrowed pure feature validation; other worker fields are not checked.
    pub fn validate(config: &EffectiveWorkerConfig) -> Result<TaskPerfPolicies> {
        Self::validate_value(config.as_value())
    }
    fn validate_value(value: &Value) -> Result<TaskPerfPolicies> {
        let fields = object(value).ok_or(TaskPerfError::PolicyMap)?;
        let policies = policy_entries(fields.get(&key("employeePerfPolicies")))?;
        let enabled = fields
            .get(&key("rootlessDocker"))
            .and_then(object)
            .and_then(|v| v.get(&key("enabled")))
            .is_some_and(|v| matches!(v.0, Node::Bool(true)));
        Ok(TaskPerfPolicies::try_new(policies, enabled)?)
    }
    pub fn policies(&self) -> &TaskPerfPolicies {
        &self.policies
    }
    pub fn has_task_perf_marker(&self) -> bool {
        marker_matches(&self.value)
    }
    /// Apply only a selected current employee's fixed artifact data. The host
    /// brackets observation with real current-employee reads independently.
    pub fn project(
        &self,
        employee: Option<&ProfileEmployeeId>,
        artifact: Option<&TaskPerfArtifactData>,
    ) -> Result<TaskPerfProjection> {
        let mut result = self.value.deep_clone();
        let Node::Object(fields) = &mut result.0 else {
            unreachable!("checked configuration object");
        };
        fields.remove(&key("employeePerfPolicies"));
        let selected = self.policies.selected(employee);
        if let Some(policy) = selected {
            let fixed = artifact
                .ok_or(TaskPerfError::FixedArtifactRequired)?
                .manifest();
            let Some(Value(Node::Object(docker))) = fields.get_mut(&key("rootlessDocker")) else {
                return Err(TaskPerfError::FixedBaseRequired);
            };
            if docker
                .get(&key("seccompProfile"))
                .and_then(string)
                .as_deref()
                != Some(fixed.base_profile())
                || docker
                    .get(&key("seccompSha256"))
                    .and_then(string)
                    .as_deref()
                    != Some(fixed.base_sha256())
            {
                return Err(TaskPerfError::FixedBaseRequired);
            }
            docker.insert(key("seccompProfile"), scalar(fixed.profile()));
            docker.insert(key("seccompSha256"), scalar(fixed.profile_sha256()));
            fields.insert(key(MARKER), scalar(policy.name()));
        }
        let Node::Object(fields) = std::mem::replace(&mut result.0, Node::Null) else {
            unreachable!("checked configuration object");
        };
        Ok(TaskPerfProjection {
            config: EffectiveWorkerConfig::from_object(fields),
            selected: selected.is_some(),
        })
    }
    pub fn recognized(
        &self,
        artifact: &TaskPerfArtifactData,
        profile: &TaskPerfProfile,
    ) -> Result<()> {
        recognize_value(&self.value, artifact, profile)
    }
}
/// Recognize already captured effective data without revalidating unrelated
/// employee policy maps. The original rootless enabled() has this exact scope.
pub fn recognize_configuration(
    config: &EffectiveWorkerConfig,
    artifact: &TaskPerfArtifactData,
    profile: &TaskPerfProfile,
) -> Result<()> {
    recognize_value(config.as_value(), artifact, profile)
}
fn recognize_value(
    value: &Value,
    artifact: &TaskPerfArtifactData,
    profile: &TaskPerfProfile,
) -> Result<()> {
    let fields = object(value).ok_or(TaskPerfError::Marker)?;
    if !marker_matches(value) {
        return Err(TaskPerfError::Marker);
    }
    let docker = fields
        .get(&key("rootlessDocker"))
        .and_then(object)
        .ok_or(TaskPerfError::Marker)?;
    let fixed = artifact.manifest();
    if docker
        .get(&key("seccompProfile"))
        .and_then(string)
        .as_deref()
        != Some(fixed.profile())
        || docker
            .get(&key("seccompSha256"))
            .and_then(string)
            .as_deref()
            != Some(fixed.profile_sha256())
        || !profile.equivalent(artifact.selected())
    {
        return Err(TaskPerfError::Derivative);
    }
    Ok(())
}
/// Check captured selection marker data before observing a fixed artifact.
pub fn validate_selection_marker(config: &EffectiveWorkerConfig) -> Result<()> {
    if marker_matches(config.as_value()) {
        Ok(())
    } else {
        Err(TaskPerfError::Marker)
    }
}
fn marker_matches(value: &Value) -> bool {
    object(value)
        .and_then(|fields| fields.get(&key(MARKER)))
        .and_then(string)
        .as_deref()
        == Some(TaskPerfPolicy::TaskV1.name())
}
fn policy_entries(value: Option<&Value>) -> Result<BTreeMap<ProfileEmployeeId, TaskPerfPolicy>> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let entries = object(value).ok_or(TaskPerfError::PolicyMap)?;
    if entries.len() > MAX_PERF_EMPLOYEES {
        return Err(TaskPerfPolicyError::EmployeeCount.into());
    }
    let mut policies = BTreeMap::new();
    for (employee, policy) in entries {
        let employee: String = employee
            .0
            .iter()
            .map(|&c| char::from_u32(c))
            .collect::<Option<_>>()
            .ok_or(TaskPerfError::PolicyMap)?;
        let employee = ProfileEmployeeId::parse(&employee).map_err(|_| TaskPerfError::PolicyMap)?;
        if string(policy).as_deref() != Some(TaskPerfPolicy::TaskV1.name()) {
            return Err(TaskPerfError::PolicyMap);
        }
        policies.insert(employee, TaskPerfPolicy::TaskV1);
    }
    Ok(policies)
}
pub struct TaskPerfProjection {
    config: EffectiveWorkerConfig,
    selected: bool,
}
impl TaskPerfProjection {
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.config
    }
    pub fn into_configuration(self) -> EffectiveWorkerConfig {
        self.config
    }
    pub fn selected(&self) -> bool {
        self.selected
    }
}
