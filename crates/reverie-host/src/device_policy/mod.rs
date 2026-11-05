//! Read-side GPU/current-employee and soft-memory/storage-identity composition.
//! Repeated observations return data, never an owner grant or a lifetime lease.
use reverie_contracts::broker_resources::ResourceConfigError;
use reverie_contracts::device_policy::{DeviceConfigError, gpu, memory};
use reverie_contracts::resource_config::checked_effective_policy;
use reverie_contracts::storage_identity::CurrentEmployee;
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_core::device_policy::{GpuPolicies, GpuSessionGrants, MemoryPolicies};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::resources::ResourcePolicy;
use reverie_store::storage_identity::{self, IdentityError, StorageIdentityConfig};
use std::fmt;

#[derive(Debug)]
pub enum DevicePolicyHostError {
    Data(DeviceConfigError),
    Resources(ResourceConfigError),
    Identity(IdentityError),
    CurrentEmployeeChanged,
    StorageIdentityChanged,
}
impl DevicePolicyHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Data(error) => error.code(),
            Self::Resources(error) => error.code(),
            Self::Identity(error) => error.code(),
            Self::CurrentEmployeeChanged => "GPU_EMPLOYEE_BINDING_CHANGED",
            Self::StorageIdentityChanged => "MEMORY_STORAGE_BINDING_CHANGED",
        }
    }
}
impl fmt::Display for DevicePolicyHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for DevicePolicyHostError {}
impl From<DeviceConfigError> for DevicePolicyHostError {
    fn from(value: DeviceConfigError) -> Self {
        Self::Data(value)
    }
}
impl From<IdentityError> for DevicePolicyHostError {
    fn from(value: IdentityError) -> Self {
        Self::Identity(value)
    }
}
impl From<ResourceConfigError> for DevicePolicyHostError {
    fn from(value: ResourceConfigError) -> Self {
        Self::Resources(value)
    }
}
type Result<T> = std::result::Result<T, DevicePolicyHostError>;

fn gpu_observation<T>(
    config: &EffectiveWorkerConfig,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
    project: impl FnOnce(
        &GpuPolicies,
        Option<&CurrentEmployee>,
    ) -> std::result::Result<T, DeviceConfigError>,
) -> Result<T> {
    let policies = gpu::validate_config(config)?;
    if !policies.needs_current_employee(session) {
        return Ok(project(&policies, None)?);
    }
    let before = storage_identity::current_employee(identity, session)?;
    let candidate = project(&policies, before.as_ref())?;
    #[cfg(test)]
    tests::hit(tests::Point::GpuProjected);
    if storage_identity::current_employee(identity, session)? != before {
        return Err(DevicePolicyHostError::CurrentEmployeeChanged);
    }
    Ok(candidate)
}
/// Resolve only a fresh current employee. Historical storage is insufficient;
/// explicit SID priority and empty maps require no registry observation.
/// Identity configuration must belong to the same captured worker domain.
pub fn projected_gpu_grants(
    config: &EffectiveWorkerConfig,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
) -> Result<Option<GpuSessionGrants>> {
    gpu_observation(config, identity, session, |policies, current| {
        gpu::projected_gpu_grants(policies, session, current)
    })
}
/// Return the existing fixed engine-argument data; no engine is invoked.
pub fn gpu_create_args(
    config: &EffectiveWorkerConfig,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
) -> Result<Vec<String>> {
    gpu_observation(config, identity, session, |policies, current| {
        gpu::gpu_create_args(policies, session, current)
    })
}
/// Existing resource_config gating differs from direct GPU functions: inactive
/// legacy gpuGrants retain their original data without unnecessary validation.
pub fn project_gpu_resources(
    config: &EffectiveWorkerConfig,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
    resources: EffectiveWorkerConfig,
) -> Result<EffectiveWorkerConfig> {
    if !gpu::resource_projection_required(config)? {
        return Ok(resources);
    }
    let grants = projected_gpu_grants(config, identity, session)?;
    Ok(gpu::apply(resources, grants.as_ref()))
}
/// Direct memory feature validation precedes storage selection. Historical
/// employee storage deliberately remains eligible for policy projection.
pub fn project_memory(
    config: &EffectiveWorkerConfig,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
    resources: EffectiveWorkerConfig,
    effective: Option<&ResourcePolicy>,
) -> Result<memory::MemoryProjection> {
    memory_observation(config, identity, session, |policies, employee| {
        Ok(memory::project(policies, resources, employee, effective)?)
    })
}
fn memory_observation(
    config: &EffectiveWorkerConfig,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
    project: impl FnOnce(
        &MemoryPolicies,
        Option<&ProfileEmployeeId>,
    ) -> Result<memory::MemoryProjection>,
) -> Result<memory::MemoryProjection> {
    let policies = memory::validate(config)?;
    if policies.policies().is_empty() {
        return project(&policies, None);
    }
    let before = storage_identity::storage_paths(identity, session)?;
    let candidate = project(&policies, before.employee())?;
    #[cfg(test)]
    tests::hit(tests::Point::MemoryProjected);
    if storage_identity::storage_paths(identity, session)? != before {
        return Err(DevicePolicyHostError::StorageIdentityChanged);
    }
    Ok(candidate)
}
/// Preserve resource_config's inactive-memory truthiness rule independently of
/// strict direct feature validation. No RAM or registry is read in that branch.
pub fn project_memory_resources(
    config: &EffectiveWorkerConfig,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
    resources: EffectiveWorkerConfig,
    effective: Option<&ResourcePolicy>,
) -> Result<memory::MemoryProjection> {
    if !memory::resource_projection_required(config) {
        return inactive_memory(resources);
    }
    project_memory(config, identity, session, resources, effective)
}
/// Derive the checked effective ceiling from projected resource data only when
/// storage selection finds a high threshold. Inactive, unselected and swap-only
/// paths retain their original permissive handling of unrelated resource data.
pub fn project_effective_memory_resources(
    config: &EffectiveWorkerConfig,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
    resources: EffectiveWorkerConfig,
) -> Result<memory::MemoryProjection> {
    if !memory::resource_projection_required(config) {
        return inactive_memory(resources);
    }
    memory_observation(config, identity, session, |policies, employee| {
        let effective = policies
            .selected(employee)
            .and_then(|policy| policy.memory_high_mib())
            .map(|_| checked_effective_policy(&resources))
            .transpose()?;
        Ok(memory::project(
            policies,
            resources,
            employee,
            effective.as_ref(),
        )?)
    })
}
fn inactive_memory(resources: EffectiveWorkerConfig) -> Result<memory::MemoryProjection> {
    Ok(memory::project(
        &MemoryPolicies::default(),
        resources,
        None,
        None,
    )?)
}

#[cfg(test)]
mod tests;
