use super::{DeviceConfigError, Result, key, object, root, take_root, text};
use crate::legacy_json::{self, Node, Value};
use crate::storage_identity::CurrentEmployee;
use crate::worker_config::EffectiveWorkerConfig;
use reverie_core::device_policy::{
    DevicePolicyError, GpuEmployeeGrants, GpuPolicies, GpuSessionGrants, MAX_GPU_GRANTS,
    NvidiaCdiDevice,
};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use std::collections::BTreeMap;

fn grants<K: Ord>(
    value: &Value,
    parse: impl Fn(&str) -> std::result::Result<K, reverie_core::ValueError>,
) -> Result<BTreeMap<K, NvidiaCdiDevice>> {
    let values = object(value).ok_or(DeviceConfigError::GpuShape)?;
    if values.len() > MAX_GPU_GRANTS {
        return Err(DevicePolicyError::GpuCount.into());
    }
    let mut result = BTreeMap::new();
    for (identity, device) in values {
        let Node::String(device) = &device.0 else {
            return Err(DeviceConfigError::GpuShape);
        };
        result.insert(
            parse(&text(identity)?)?,
            NvidiaCdiDevice::parse(&text(device)?)?,
        );
    }
    Ok(result)
}
/// Direct legacy-map validation; nil canonical UUIDs and device hex case survive.
pub fn validate_grants(raw: &[u8]) -> Result<GpuSessionGrants> {
    let value = legacy_json::decode_utf8(raw).map_err(|error| match error {
        legacy_json::Error::InvalidJson => DeviceConfigError::Json,
        legacy_json::Error::DuplicateKey => DeviceConfigError::DuplicateKey,
    })?;
    grants(&value, ProfileSessionId::parse)
}
pub fn validate_config(config: &EffectiveWorkerConfig) -> Result<GpuPolicies> {
    let data = root(config);
    let legacy = data
        .get(&key("gpuGrants"))
        .map(|value| grants(value, ProfileSessionId::parse))
        .transpose()?;
    let employees: GpuEmployeeGrants = data
        .get(&key("employeeGpuGrants"))
        .map(|value| grants(value, ProfileEmployeeId::parse))
        .transpose()?
        .unwrap_or_default();
    Ok(GpuPolicies::try_new(legacy, employees)?)
}
/// resource_config always checks the employee-map container, but leaves legacy
/// gpuGrants untouched when that employee map is empty. Direct calls validate both.
pub fn resource_projection_required(config: &EffectiveWorkerConfig) -> Result<bool> {
    match root(config).get(&key("employeeGpuGrants")) {
        None => Ok(false),
        Some(value) => Ok(!object(value).ok_or(DeviceConfigError::GpuShape)?.is_empty()),
    }
}
fn employee<'a>(
    policies: &GpuPolicies,
    session: &ProfileSessionId,
    current: Option<&'a CurrentEmployee>,
) -> Result<Option<&'a ProfileEmployeeId>> {
    if !policies.needs_current_employee(session) {
        return Ok(None);
    }
    if current.is_some_and(|current| current.session() != session) {
        return Err(DeviceConfigError::CurrentEmployeeMismatch);
    }
    Ok(current.map(CurrentEmployee::identity))
}
/// Uses current identity data only. Native composition must supply a fresh read;
/// serialized employee/generation fields confer no permission to grant a device.
pub fn projected_gpu_grants(
    policies: &GpuPolicies,
    session: &ProfileSessionId,
    current: Option<&CurrentEmployee>,
) -> Result<Option<GpuSessionGrants>> {
    Ok(policies.project(session, employee(policies, session, current)?))
}
pub fn gpu_create_args(
    policies: &GpuPolicies,
    session: &ProfileSessionId,
    current: Option<&CurrentEmployee>,
) -> Result<Vec<String>> {
    Ok(policies.create_args(session, employee(policies, session, current)?))
}
/// Patch only the resulting gpuGrants entry in application-owned resource data.
pub fn apply(
    resources: EffectiveWorkerConfig,
    grants: Option<&GpuSessionGrants>,
) -> EffectiveWorkerConfig {
    let Some(grants) = grants else {
        return resources;
    };
    let value = grants
        .iter()
        .map(|(session, device)| {
            (
                key(session.as_str()),
                Value(Node::String(key(device.as_str()))),
            )
        })
        .collect();
    let mut data = take_root(resources);
    data.insert(key("gpuGrants"), Value(Node::Object(value)));
    EffectiveWorkerConfig::from_object(data)
}
