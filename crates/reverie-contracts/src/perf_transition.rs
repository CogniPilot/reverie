//! Fixed PERF-only cold transition DATA; never filesystem or launch authority.
use crate::{
    reservation_control::{self, ControlBinding},
    task_perf_v1::TaskPerfConfiguration,
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_core::{ids::ProfileEmployeeId, task_perf::TaskPerfPolicy};

#[derive(Debug)]
pub enum PerfTransitionDataError {
    Refused(&'static str),
    Configuration(worker_config::WorkerConfigError),
    Policy(crate::task_perf_v1::TaskPerfError),
    Control(reservation_control::ControlDataError),
}
impl std::fmt::Display for PerfTransitionDataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(code) => f.write_str(code),
            Self::Configuration(_) => f.write_str("PERF_CONFIGURATION_DATA"),
            Self::Policy(e) => e.fmt(f),
            Self::Control(e) => e.fmt(f),
        }
    }
}
impl PerfTransitionDataError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Configuration(_) => "PERF_CONFIGURATION_DATA",
            Self::Policy(e) => e.code(),
            Self::Control(e) => e.code(),
        }
    }
}
impl std::error::Error for PerfTransitionDataError {}
type Result<T> = std::result::Result<T, PerfTransitionDataError>;

pub struct PerfTransition {
    before: EffectiveWorkerConfig,
    after: EffectiveWorkerConfig,
    employee: ProfileEmployeeId,
    policy: Option<TaskPerfPolicy>,
    binding: ControlBinding,
    before_binding: ControlBinding,
}
impl PerfTransition {
    pub fn prepare(
        before: &EffectiveWorkerConfig,
        employee: ProfileEmployeeId,
        policy: Option<TaskPerfPolicy>,
        binding: &ControlBinding,
    ) -> Result<Self> {
        if policy.is_some_and(|p| p != TaskPerfPolicy::TaskV2) {
            return Err(PerfTransitionDataError::Refused("PERF_FIXED_V2_REQUIRED"));
        }
        TaskPerfConfiguration::validate(before).map_err(PerfTransitionDataError::Policy)?;
        if reservation_control::domain_digest(before).map_err(PerfTransitionDataError::Control)?
            != *binding.domain()
        {
            return Err(PerfTransitionDataError::Refused("PERF_DOMAIN_CHANGED"));
        }
        let mut after = before.clone();
        after
            .patch_employee_perf_policy(&employee, policy)
            .ok_or(PerfTransitionDataError::Refused("PERF_POLICY_MAP"))?;
        TaskPerfConfiguration::validate(&after).map_err(PerfTransitionDataError::Policy)?;
        if worker_config::equivalent(before, &after) {
            return Err(PerfTransitionDataError::Refused("PERF_ALREADY_CONFIGURED"));
        }
        let next = binding
            .configuration_rebound(&after)
            .map_err(PerfTransitionDataError::Control)?;
        Ok(Self {
            before: before.clone(),
            after,
            employee,
            policy,
            binding: next,
            before_binding: binding.clone(),
        })
    }
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn after(&self) -> &EffectiveWorkerConfig {
        &self.after
    }
    pub fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn policy(&self) -> Option<TaskPerfPolicy> {
        self.policy
    }
    pub fn after_binding(&self) -> &ControlBinding {
        &self.binding
    }
    pub fn matches_before_configuration(
        &self,
        metadata: &crate::storage_identity::OrderedMetadata,
    ) -> bool {
        self.before.as_value().python_eq(metadata.as_value())
    }
    pub fn matches_after_configuration(
        &self,
        metadata: &crate::storage_identity::OrderedMetadata,
    ) -> bool {
        self.after.as_value().python_eq(metadata.as_value())
    }
    pub fn matches_before_binding(
        &self,
        metadata: &crate::storage_identity::OrderedMetadata,
    ) -> bool {
        self.before_binding.matches_metadata(metadata)
    }
    pub fn matches_after_binding(
        &self,
        metadata: &crate::storage_identity::OrderedMetadata,
    ) -> bool {
        self.binding.matches_metadata(metadata)
    }
    pub fn matches_pending_metadata(
        &self,
        metadata: &crate::storage_identity::OrderedMetadata,
        operation: &reverie_core::operations::JournalId,
        preview: &reverie_core::operations::JournalDigest,
    ) -> bool {
        crate::legacy_json::decode_metadata_bytes(&self.pending_bytes(operation, preview))
            .is_ok_and(|value| value.python_eq(metadata.as_value()))
    }
    pub fn configuration_bytes(&self) -> Vec<u8> {
        worker_config::publication_bytes(&self.after)
    }
    pub fn binding_bytes(&self) -> Vec<u8> {
        worker_config::compact_data(&self.binding.configuration_data())
    }
    pub fn pending_bytes(
        &self,
        operation: &reverie_core::operations::JournalId,
        preview: &reverie_core::operations::JournalDigest,
    ) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schema":"reverie-owner-perf-transition-v1",
            "operationId":operation.as_str(), "previewDigest":preview.as_str(),
            "employeeId":self.employee.as_str(), "policy":self.policy.map(TaskPerfPolicy::name),
            "beforeDigest":worker_config::config_digest(&self.before).to_hex(),
            "afterDigest":worker_config::config_digest(&self.after).to_hex(),
            "afterDomain":self.binding.domain().to_hex()
        }))
        .expect("fixed scalar PERF pending DATA")
    }
}
