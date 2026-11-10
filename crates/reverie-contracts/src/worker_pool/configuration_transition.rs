//! Before/after publication DATA only. No native owner, consent, pending,
//! admission, controller installation or checked file-CAS follows from this.
use super::{PoolPolicyError, WorkerPoolMemberPolicy, WorkerPoolPolicy, WorkerPoolProvider};
use crate::{
    broker_resources::{self, ResourceConfigError},
    device_policy::{DeviceConfigError, memory},
    legacy_json::{Node, Number, Text, Value},
    reservation_control::{self, ControlBinding, ControlDataError},
    storage_identity::OrderedMetadata,
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    resources::{BudgetMode, CpuQuota, ResourcePolicy, ResourceTemplate},
};
use std::collections::BTreeMap;
mod memory_policies;
mod projection;
mod resources;
pub use projection::PoolConfigurationDataError;
type Result<T> = std::result::Result<T, PoolConfigurationDataError>;
type Object = BTreeMap<Text, Value>;

pub struct WorkerPoolConfigurationTransition {
    before: EffectiveWorkerConfig,
    after: EffectiveWorkerConfig,
    before_binding: ControlBinding,
    after_binding: ControlBinding,
    policy: WorkerPoolPolicy,
    member_edit: Option<PoolMemberPolicyEdit>,
}

pub struct PoolMemberPolicyEdit {
    employee: ProfileEmployeeId,
    previous: WorkerPoolMemberPolicy,
    requested: WorkerPoolMemberPolicy,
    previous_revision: u64,
}

impl PoolMemberPolicyEdit {
    pub fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn previous(&self) -> WorkerPoolMemberPolicy {
        self.previous
    }
    pub fn requested(&self) -> WorkerPoolMemberPolicy {
        self.requested
    }
    pub fn previous_revision(&self) -> u64 {
        self.previous_revision
    }
}
impl WorkerPoolConfigurationTransition {
    pub fn prepare(
        before: &EffectiveWorkerConfig,
        policy: &WorkerPoolPolicy,
        binding: &ControlBinding,
        sessions: &BTreeMap<ProfileSessionId, ProfileEmployeeId>,
    ) -> Result<Self> {
        policy
            .validate()
            .map_err(PoolConfigurationDataError::Policy)?;
        let domain = reservation_control::domain_digest(before)
            .map_err(PoolConfigurationDataError::Control)?;
        need(
            domain == *binding.domain(),
            "WORKER_POOL_CONFIGURATION_DOMAIN",
        )?;
        let after = resources::candidate(before, policy, sessions)?;
        projection::validate(&after, policy, sessions)?;
        let after_binding = binding
            .configuration_rebound(&after)
            .map_err(PoolConfigurationDataError::Control)?;
        Ok(Self {
            before: before.clone(),
            after,
            before_binding: binding.clone(),
            after_binding,
            policy: policy.clone(),
            member_edit: None,
        })
    }

    /// Prepare configuration and control-binding data for one live edit.
    /// The original pool policy and every peer's settings are preserved.
    pub fn prepare_member_edit(
        before: &EffectiveWorkerConfig,
        binding: &ControlBinding,
        employee: ProfileEmployeeId,
        settings: WorkerPoolMemberPolicy,
        expected_revision: u64,
    ) -> Result<Self> {
        let domain = reservation_control::domain_digest(before)
            .map_err(PoolConfigurationDataError::Control)?;
        need(
            domain == *binding.domain(),
            "WORKER_POOL_CONFIGURATION_DOMAIN",
        )?;
        let provider = WorkerPoolProvider::from_config(before)
            .map_err(PoolConfigurationDataError::Policy)?
            .ok_or(PoolConfigurationDataError::Refused(
                "WORKER_POOL_PROVIDER_REQUIRED",
            ))?;
        need(
            expected_revision == provider.member_revision(),
            "WORKER_POOL_MEMBER_REVISION_CHANGED",
        )?;
        let previous = provider.member_policy(employee.as_str()).ok_or(
            PoolConfigurationDataError::Refused("WORKER_POOL_MEMBER_POLICY"),
        )?;
        need(previous != settings, "WORKER_POOL_MEMBER_POLICY_UNCHANGED")?;
        let after = WorkerPoolProvider::project_member_policy(before, &employee, settings)
            .map_err(PoolConfigurationDataError::Policy)?;
        let after_binding = binding
            .configuration_rebound(&after)
            .map_err(PoolConfigurationDataError::Control)?;
        Ok(Self {
            before: before.clone(),
            after,
            before_binding: binding.clone(),
            after_binding,
            policy: provider.policy().clone(),
            member_edit: Some(PoolMemberPolicyEdit {
                employee,
                previous,
                requested: settings,
                previous_revision: expected_revision,
            }),
        })
    }

    pub fn member_edit(&self) -> Option<&PoolMemberPolicyEdit> {
        self.member_edit.as_ref()
    }
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn after(&self) -> &EffectiveWorkerConfig {
        &self.after
    }
    pub fn policy(&self) -> &WorkerPoolPolicy {
        &self.policy
    }
    pub fn after_binding(&self) -> &ControlBinding {
        &self.after_binding
    }
    pub fn configuration_bytes(&self) -> Vec<u8> {
        worker_config::publication_bytes(&self.after)
    }
    pub fn binding_bytes(&self) -> Vec<u8> {
        worker_config::compact_data(&self.after_binding.configuration_data())
    }
    pub fn matches_before_configuration(&self, metadata: &OrderedMetadata) -> bool {
        self.before.as_value().python_eq(metadata.as_value())
    }
    pub fn matches_after_configuration(&self, metadata: &OrderedMetadata) -> bool {
        self.after.as_value().python_eq(metadata.as_value())
    }
    pub fn matches_before_binding(&self, metadata: &OrderedMetadata) -> bool {
        self.before_binding.matches_metadata(metadata)
    }
    pub fn matches_after_binding(&self, metadata: &OrderedMetadata) -> bool {
        self.after_binding.matches_metadata(metadata)
    }
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn need(ok: bool, code: &'static str) -> Result<()> {
    ok.then_some(())
        .ok_or(PoolConfigurationDataError::Refused(code))
}
fn object(value: &Value) -> Result<&Object> {
    match &value.0 {
        Node::Object(fields) => Ok(fields),
        _ => Err(PoolConfigurationDataError::Refused(
            "WORKER_POOL_CONFIGURATION_OBJECT",
        )),
    }
}
fn integer(value: u32) -> Value {
    Value(Node::Number(Number::Integer(value.to_string())))
}
