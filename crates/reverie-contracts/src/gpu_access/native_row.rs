use super::*;
use crate::{
    reservation_engine::{ContainerRow, InventoryRows},
    storage_identity::CurrentEmployee,
    worker_config::{EffectiveWorkerConfig, WorkerPolicyDigest},
};
use reverie_core::ids::ContainerId;
fn labels(row: &ContainerRow) -> Result<Option<&Object>> {
    let root = object(row.data()).ok_or(GpuDataError::NativeBinding)?;
    let Some(config) = field(root, "Config") else {
        return Ok(None);
    };
    let config = object(config).ok_or(GpuDataError::NativeBinding)?;
    field(config, "Labels")
        .map(|value| object(value).ok_or(GpuDataError::NativeBinding))
        .transpose()
}
fn label(row: &ContainerRow, name: &str, expected: &str) -> Result<bool> {
    Ok(labels(row)?
        .and_then(|fields| field(fields, name))
        .and_then(text)
        .as_deref()
        == Some(expected))
}
/// Selection DATA only. Application must keep the actual context's sealed row
/// handle for every limits/custody read; this returned ID cannot mint one.
pub fn selected_container(
    rows: &InventoryRows,
    config: &EffectiveWorkerConfig,
    current: &CurrentEmployee,
) -> Result<Option<ContainerId>> {
    let deployment = object(config.as_value())
        .and_then(|fields| field(fields, "deployment"))
        .and_then(text)
        .ok_or(GpuDataError::Configuration)?;
    let name = format!("/{deployment}-agent-{}", current.session().as_str());
    let mut matches = Vec::new();
    for row in rows.rows() {
        if row.name_is(&name) || label(row, "reverie.session", current.session().as_str())? {
            matches.push(row);
        }
    }
    if matches.len() > 1 {
        return Err(GpuDataError::NativeAmbiguous);
    }
    let Some(row) = matches.pop() else {
        return Ok(None);
    };
    if !row.name_is(&name)
        || !label(row, "reverie.worker", &deployment)?
        || !label(row, "reverie.session", current.session().as_str())?
        || !label(row, "reverie.employee", current.identity().as_str())?
        || row.running().is_err()
    {
        return Err(GpuDataError::NativeBinding);
    }
    Ok(Some(row.id().clone()))
}
pub fn policy_label_matches(row: &ContainerRow, policy: &WorkerPolicyDigest) -> Result<bool> {
    label(row, "reverie.worker-policy", &policy.to_hex())
}
