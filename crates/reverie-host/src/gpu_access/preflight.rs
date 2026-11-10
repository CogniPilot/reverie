//! Standalone read-only binding observation. Queue generation/roster bounds,
//! installation state, admission and mutation owners do not belong here.
use super::*;
use reverie_contracts::{
    gpu_access::preflight::{PreflightBinding, PreflightSelection},
    resource_config::ResourceIdentitySettings,
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::ids::ProfileEmployeeId;
use reverie_store::storage_identity::{self, StorageIdentityConfig};
use std::{fs, os::unix::fs::MetadataExt, path::Path};
mod process;
pub use process::preflight_process;

/// Standalone S.read_metadata policy, not the ordinary broker loader's
/// last-wins text/unbounded/hardlink-compatible owner configuration policy.
pub fn preflight_configuration(path: &Path) -> Result<EffectiveWorkerConfig> {
    let lexical = reverie_core::posix_path::PosixPath::try_new(&native::python_text(path))
        .map_err(|_| GpuHostError::Refused("GPU_PRIVATE_CONFIG"))?;
    let path = storage_identity::canonical(&native::python_path(&lexical.codepoints())?)?;
    let info = fs::symlink_metadata(&path)?;
    need(
        info.is_file() && info.mode() & 0o077 == 0,
        "GPU_PRIVATE_CONFIG",
    )?;
    let metadata = storage_identity::read_ordered_metadata(&path, native::uid(), 65536)?;
    EffectiveWorkerConfig::from_private_metadata(&metadata)
        .map_err(|_| GpuHostError::Refused("GPU_PRIVATE_CONFIG"))
}

pub fn preflight_binding(
    config: &EffectiveWorkerConfig,
    employee: &ProfileEmployeeId,
) -> Result<PreflightBinding> {
    let settings = ResourceIdentitySettings::capture_worker_config(config)
        .map_err(|_| GpuHostError::Refused("GPU_CURRENT_REGISTRY"))?;
    let identity = StorageIdentityConfig::capture_worker_settings(&settings);
    let company = storage_identity::read_company_metadata(&identity)?;
    let selection = PreflightSelection::capture(&company, employee)?;
    let current = storage_identity::current_employee(&identity, selection.session())?
        .ok_or(GpuHostError::Refused("GPU_CURRENT_EMPLOYEE"))?;
    Ok(selection.bind(current)?)
}
