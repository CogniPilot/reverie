use super::{
    DeviceConfigError, Result, integer, integer_value, key, object, root, take_root, text,
};
use crate::legacy_json::{self, Node, Value};
use crate::worker_config::EffectiveWorkerConfig;
use reverie_core::device_policy::{
    DevicePolicyError, MAX_MEMORY_POLICIES, MemoryPolicies, ProjectedMemoryPolicy, SoftMemoryPolicy,
};
use reverie_core::ids::ProfileEmployeeId;
use reverie_core::resources::ResourcePolicy;
use std::collections::BTreeMap;

fn policy(value: &Value) -> Result<SoftMemoryPolicy> {
    let fields = object(value).ok_or(DeviceConfigError::MemoryShape)?;
    let high = fields.get(&key("memoryHighMiB"));
    if fields.len() != if high.is_some() { 2 } else { 1 } || !fields.contains_key(&key("swapMiB")) {
        return Err(DeviceConfigError::MemoryShape);
    }
    Ok(SoftMemoryPolicy::try_new(
        high.map(|value| integer(Some(value))).transpose()?,
        integer(fields.get(&key("swapMiB")))?,
    )?)
}
/// Direct feature validation always checks the map and pool, including empty maps.
pub fn validate(config: &EffectiveWorkerConfig) -> Result<MemoryPolicies> {
    let data = root(config);
    let pool = data
        .get(&key("laptopSwapPoolMiB"))
        .map(|value| integer(Some(value)))
        .transpose()?
        .unwrap_or(0);
    let mut policies = BTreeMap::new();
    if let Some(values) = data.get(&key("employeeMemoryPolicies")) {
        let values = object(values).ok_or(DeviceConfigError::MemoryShape)?;
        if values.len() > MAX_MEMORY_POLICIES {
            return Err(DevicePolicyError::MemoryCount.into());
        }
        for (employee, value) in values {
            policies.insert(ProfileEmployeeId::parse(&text(employee)?)?, policy(value)?);
        }
    }
    Ok(MemoryPolicies::try_new(policies, pool)?)
}
/// The legacy resource_config callsite skips this feature for false/empty data,
/// even if inactive pool or map fields would fail direct validate().
pub fn resource_projection_required(config: &EffectiveWorkerConfig) -> bool {
    legacy_json::truthy(root(config).get(&key("employeeMemoryPolicies")))
}
pub struct MemoryProjection {
    configuration: EffectiveWorkerConfig,
    policy: Option<ProjectedMemoryPolicy>,
}
impl MemoryProjection {
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.configuration
    }
    pub fn into_configuration(self) -> EffectiveWorkerConfig {
        self.configuration
    }
    pub fn policy(&self) -> Option<&ProjectedMemoryPolicy> {
        self.policy.as_ref()
    }
    /// Finite checked selected commitment only; host swap admission is separate.
    pub fn swap_bytes(&self) -> u64 {
        swap_bytes(self.policy.as_ref())
    }
}
/// Existing optional-policy zero default, applied only to checked projection
/// data. This does not interpret arbitrary private Python helper values.
pub fn swap_bytes(policy: Option<&ProjectedMemoryPolicy>) -> u64 {
    policy.map_or(0, ProjectedMemoryPolicy::swap_bytes)
}
/// Project using trusted storage identity, including historical employee storage.
/// Selected high thresholds take the actual checked effective RAM policy and
/// bind it to resource data. This is not an arbitrary-Python-object helper.
/// Unselected/swap-only paths never inspect or validate the RAM ceiling.
pub fn project(
    policies: &MemoryPolicies,
    resources: EffectiveWorkerConfig,
    storage_employee: Option<&ProfileEmployeeId>,
    effective: Option<&ResourcePolicy>,
) -> Result<MemoryProjection> {
    let projected = policies.project(storage_employee, effective)?;
    let Some(policy) = &projected else {
        return Ok(MemoryProjection {
            configuration: resources,
            policy: None,
        });
    };
    if policy.policy().memory_high_mib().is_some() {
        let expected = effective
            .ok_or(DevicePolicyError::EffectiveCeiling)?
            .memory_mib();
        if integer(root(&resources).get(&key("memoryMiB")))? != expected {
            return Err(DeviceConfigError::EffectiveCeilingMismatch);
        }
    }
    let mut fields = BTreeMap::new();
    if let Some(high) = policy.policy().memory_high_mib() {
        fields.insert(key("memoryHighMiB"), integer_value(high));
    }
    fields.insert(key("swapMiB"), integer_value(policy.policy().swap_mib()));
    fields.insert(key("swapPoolMiB"), integer_value(policy.swap_pool_mib()));
    let mut data = take_root(resources);
    data.insert(key("laptopMemoryPolicy"), Value(Node::Object(fields)));
    Ok(MemoryProjection {
        configuration: EffectiveWorkerConfig::from_object(data),
        policy: projected,
    })
}
