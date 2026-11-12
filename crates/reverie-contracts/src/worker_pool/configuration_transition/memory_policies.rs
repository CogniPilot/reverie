use super::*;
use reverie_core::device_policy::{MemoryPolicies, ProjectedMemoryPolicy, SoftMemoryPolicy};

pub(super) fn employees(before: &MemoryPolicies, policy: &WorkerPoolPolicy) -> Result<Value> {
    for employee in before.policies().keys() {
        need(
            policy
                .employee_memory_high_mi_b
                .contains_key(employee.as_str()),
            "WORKER_POOL_CONFIGURATION_UNAPPROVED_MEMORY",
        )?;
    }
    let mut rows = Object::new();
    for (employee, high) in &policy.employee_memory_high_mi_b {
        let id = ProfileEmployeeId::parse(employee)
            .map_err(ResourceConfigError::from)
            .map_err(PoolConfigurationDataError::Resources)?;
        let swap = before
            .selected(Some(&id))
            .map_or(0, SoftMemoryPolicy::swap_mib);
        checked(*high, swap)?;
        rows.insert(
            key(employee),
            Value(Node::Object(BTreeMap::from([
                (key("memoryHighMiB"), integer(*high)),
                (key("swapMiB"), integer(swap)),
            ]))),
        );
    }
    Ok(Value(Node::Object(rows)))
}

pub(super) fn session(
    before: Option<&ProjectedMemoryPolicy>,
    employee: &ProfileEmployeeId,
    policy: &WorkerPoolPolicy,
    memory: &MemoryPolicies,
) -> Result<Value> {
    let high = *policy
        .employee_memory_high_mi_b
        .get(employee.as_str())
        .ok_or(PoolConfigurationDataError::Refused(
            "WORKER_POOL_CONFIGURATION_UNAPPROVED_SESSION",
        ))?;
    let swap = before.map_or(0, |memory| memory.policy().swap_mib());
    let pool = before.map_or(memory.swap_pool_mib(), ProjectedMemoryPolicy::swap_pool_mib);
    checked(high, swap)?;
    Ok(Value(Node::Object(BTreeMap::from([
        (key("memoryHighMiB"), integer(high)),
        (key("swapMiB"), integer(swap)),
        (key("swapPoolMiB"), integer(pool)),
    ]))))
}

fn checked(high: u32, swap: u32) -> Result<()> {
    SoftMemoryPolicy::try_new(Some(high), swap)
        .map_err(DeviceConfigError::from)
        .map_err(PoolConfigurationDataError::Memory)?;
    // Preserve explicit swap DATA, but never erase it to make this currently
    // zero-swap native provider appear compatible.
    need(swap == 0, "WORKER_POOL_CONFIGURATION_SWAP_UNSUPPORTED")
}
