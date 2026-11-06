use super::error::Result;
use reverie_contracts::{
    device_policy::{gpu, memory},
    lease_policy::LeaseConfig,
    resource_config::ResourceConfiguration,
    task_perf_v1::TaskPerfConfiguration,
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{device_policy::GpuSessionGrants, ids::ProfileSessionId};
use reverie_host::{
    device_policy::{self, DevicePolicyHostError},
    lease_policy::{self, LeaseHostError},
    task_perf::{self, TaskPerfHostError},
    worker_identity,
};
use reverie_store::storage_identity::{self, StorageIdentityConfig};

/// Resolve the existing resource -> perf -> memory -> lease data workflow.
/// This is protected broker-domain data, not a public configuration editor.
/// It neither grants start permission nor validates the whole worker schema.
pub fn effective_config(
    config: EffectiveWorkerConfig,
    session: &ProfileSessionId,
) -> Result<EffectiveWorkerConfig> {
    let captured = ResourceConfiguration::capture(config)?;
    let result = resource_config(&captured, session)?;
    let lease = LeaseConfig::capture(result).map_err(LeaseHostError::from)?;
    Ok(lease_policy::project_lease(lease, session)?.into_config())
}
fn identity(captured: &ResourceConfiguration) -> Result<StorageIdentityConfig> {
    Ok(worker_identity::storage_identity(
        &captured.identity_settings()?,
    )?)
}
fn gpu_grants(
    captured: &ResourceConfiguration,
    session: &ProfileSessionId,
) -> Result<Option<GpuSessionGrants>> {
    if !gpu::resource_projection_required(captured.source()).map_err(DevicePolicyHostError::from)? {
        return Ok(None);
    }
    let policies = gpu::validate_config(captured.source()).map_err(DevicePolicyHostError::from)?;
    if !policies.needs_current_employee(session) {
        return Ok(gpu::projected_gpu_grants(&policies, session, None)
            .map_err(DevicePolicyHostError::from)?);
    }
    Ok(device_policy::projected_gpu_grants(
        captured.source(),
        &identity(captured)?,
        session,
    )?)
}
fn resource_config(
    captured: &ResourceConfiguration,
    session: &ProfileSessionId,
) -> Result<EffectiveWorkerConfig> {
    let grants = gpu_grants(captured, session)?;
    let paths = if captured.needs_storage_employee(session) {
        Some(storage_identity::storage_paths(
            &identity(captured)?,
            session,
        )?)
    } else {
        None
    };
    let employee = paths
        .as_ref()
        .and_then(storage_identity::StoragePaths::employee);
    let resources = gpu::apply(captured.project(session, employee)?, grants.as_ref());
    let perf = TaskPerfConfiguration::for_resources(captured.source(), resources)
        .map_err(TaskPerfHostError::from)?;
    let resources = if perf.policies().entries().is_empty() {
        perf.project(None, None).map_err(TaskPerfHostError::from)?
    } else {
        task_perf::project_task_perf(&perf, &identity(captured)?, session)?
    }
    .into_configuration();
    if !memory::resource_projection_required(captured.source()) {
        return Ok(resources);
    }
    Ok(device_policy::project_effective_memory_resources(
        captured.source(),
        &identity(captured)?,
        session,
        resources,
    )?
    .into_configuration())
}
