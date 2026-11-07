use super::*;
use crate::{
    device_policy,
    storage_identity::{CurrentEmployee, OrderedMetadata},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{
    gpu_access::{GpuApplied, GpuDeviceUuid},
    operations::JournalId,
};
pub fn private_config_matches(config: &EffectiveWorkerConfig, metadata: &OrderedMetadata) -> bool {
    config.as_value().python_eq(metadata.as_value())
}
pub fn has_resource_actor(config: &EffectiveWorkerConfig) -> bool {
    object(config.as_value())
        .expect("worker object invariant")
        .contains_key(&key("resourceActorConfig"))
}
pub fn applied(config: &EffectiveWorkerConfig, current: &CurrentEmployee) -> Result<GpuApplied> {
    let policies =
        device_policy::gpu::validate_config(config).map_err(|_| GpuDataError::Configuration)?;
    Ok(GpuApplied::project(
        &policies,
        current.session(),
        current.identity(),
    ))
}
/// Copy the captured config and patch just the selected employee entry. Legacy
/// SID overrides, opaque unrelated data and session-resource observation order
/// survive unchanged; the full worker validator still runs after this step.
pub fn patch_employee_grant(
    config: &EffectiveWorkerConfig,
    employee: &JournalId,
    device: Option<&GpuDeviceUuid>,
) -> Result<EffectiveWorkerConfig> {
    let mut after = config.clone();
    after
        .patch_employee_gpu_grant(employee, device)
        .ok_or(GpuDataError::Configuration)?;
    Ok(after)
}
/// Closed proposed GPU-only document; still unvalidated worker DATA. Native
/// admission, full validation, peer hashes, file CAS and pending custody are
/// required by the actual service before either publication is attempted.
pub struct GpuCandidate {
    before: EffectiveWorkerConfig,
    after: EffectiveWorkerConfig,
}
impl GpuCandidate {
    pub fn project(
        before: &EffectiveWorkerConfig,
        employee: &JournalId,
        device: Option<&GpuDeviceUuid>,
    ) -> Result<Self> {
        Ok(Self {
            before: before.clone(),
            after: patch_employee_grant(before, employee, device)?,
        })
    }
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn after(&self) -> &EffectiveWorkerConfig {
        &self.after
    }
}
