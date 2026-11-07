use super::*;
use reverie_contracts::{
    gpu_access::{self, GpuCurrentEmployee},
    resource_config::ResourceIdentitySettings,
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::operations::JournalId;
use reverie_store::storage_identity::{self, StorageIdentityConfig};
/// First bounded registry selection, then the existing double-observation
/// current-only resolver, then the generation ceiling BEFORE policy hashing.
/// A historical storage identity never becomes a current GPU selection.
pub fn current_employee(
    config: &EffectiveWorkerConfig,
    employee: &JournalId,
) -> Result<GpuCurrentEmployee> {
    let settings = ResourceIdentitySettings::capture_worker_config(config)
        .map_err(|_| GpuHostError::Refused("GPU_CURRENT_REGISTRY"))?;
    let identity = StorageIdentityConfig::capture_worker_settings(&settings);
    let company = storage_identity::read_company_metadata(&identity)?;
    let session = gpu_access::current_session(&company, employee)?;
    let current = storage_identity::current_employee(&identity, &session)?
        .ok_or(GpuHostError::Refused("GPU_CURRENT_EMPLOYEE"))?;
    Ok(GpuCurrentEmployee::from_current(current, employee)?)
}
