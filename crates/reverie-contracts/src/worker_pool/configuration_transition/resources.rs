use super::*;

pub(super) fn candidate(
    before: &EffectiveWorkerConfig,
    policy: &WorkerPoolPolicy,
    sessions: &BTreeMap<ProfileSessionId, ProfileEmployeeId>,
) -> Result<EffectiveWorkerConfig> {
    let original = broker_resources::projection(before.as_value())
        .map_err(PoolConfigurationDataError::Resources)?;
    let defaults = crate::resource_config::checked_effective_policy(before)
        .map_err(PoolConfigurationDataError::Resources)?;
    WorkerPoolProvider::from_config(before).map_err(PoolConfigurationDataError::Policy)?;
    let memory = memory::validate(before).map_err(PoolConfigurationDataError::Memory)?;
    let mut fields: Object = object(before.as_value())?
        .iter()
        .map(|(name, value)| (name.clone(), value.deep_clone()))
        .collect();
    fields.extend(resource_fields(&defaults, policy)?);
    let employees = employee_resources(&original, &defaults, policy)?;
    fields.insert(key("employeeResources"), Value(Node::Object(employees)));
    update_sessions(&mut fields, &original, policy, sessions, &memory)?;
    fields.insert(
        key("employeeMemoryPolicies"),
        memory_policies::employees(&memory, policy)?,
    );
    let raw = serde_json::to_vec(&serde_json::json!({
        "version":1,"purpose":super::super::provider::PURPOSE,"policy":policy
    }))
    .expect("fixed checked pool policy DATA");
    fields.insert(
        key("workerPoolProvider"),
        crate::legacy_json::decode_utf8(&raw).map_err(|_| {
            PoolConfigurationDataError::Refused("WORKER_POOL_CONFIGURATION_PROVIDER")
        })?,
    );
    before
        .pool_configuration_fields(fields)
        .ok_or(PoolConfigurationDataError::Refused(
            "WORKER_POOL_CONFIGURATION_SESSION_ORDER",
        ))
}

fn resource_fields(resources: &ResourcePolicy, policy: &WorkerPoolPolicy) -> Result<Object> {
    let resource = ResourcePolicy::try_new(
        BudgetMode::Pool,
        policy.memory_max_mi_b,
        resources.pids_limit(),
        CpuQuota::from_integer(0)
            .map_err(ResourceConfigError::from)
            .map_err(PoolConfigurationDataError::Resources)?,
        policy.memory_max_mi_b,
        policy.pool_tasks_max,
    )
    .map_err(ResourceConfigError::from)
    .map_err(PoolConfigurationDataError::Resources)?;
    Ok(broker_resources::resource_fields(&ResourceTemplate::from(
        &resource,
    )))
}

fn employee_resources(
    original: &reverie_core::resource_projection::ResourceProjection,
    defaults: &ResourcePolicy,
    policy: &WorkerPoolPolicy,
) -> Result<Object> {
    for employee in original.employees().keys() {
        need(
            policy
                .employee_memory_high_mi_b
                .contains_key(employee.as_str()),
            "WORKER_POOL_CONFIGURATION_UNAPPROVED_EMPLOYEE",
        )?;
    }
    policy
        .employee_memory_high_mi_b
        .keys()
        .map(|employee| {
            let id = ProfileEmployeeId::parse(employee)
                .map_err(ResourceConfigError::from)
                .map_err(PoolConfigurationDataError::Resources)?;
            let resources = original
                .employees()
                .get(&id)
                .map(|entry| {
                    entry
                        .resolve(original.reservation_pool())
                        .map_err(ResourceConfigError::from)
                        .map_err(PoolConfigurationDataError::Resources)
                })
                .transpose()?
                .unwrap_or_else(|| defaults.clone());
            Ok((
                key(employee),
                Value(Node::Object(resource_fields(&resources, policy)?)),
            ))
        })
        .collect()
}

fn update_sessions(
    fields: &mut Object,
    original: &reverie_core::resource_projection::ResourceProjection,
    policy: &WorkerPoolPolicy,
    sessions: &BTreeMap<ProfileSessionId, ProfileEmployeeId>,
    memory: &reverie_core::device_policy::MemoryPolicies,
) -> Result<()> {
    let Some(rows) = fields.get_mut(&key("sessionResources")) else {
        return Ok(());
    };
    let Node::Object(rows) = &mut rows.0 else {
        unreachable!("validated session map");
    };
    for (session, resource) in original.sessions() {
        let employee = sessions
            .get(session)
            .ok_or(PoolConfigurationDataError::Refused(
                "WORKER_POOL_CONFIGURATION_SESSION_EMPLOYEE",
            ))?;
        let resources = resource
            .resolve(original.reservation_pool())
            .map_err(ResourceConfigError::from)
            .map_err(PoolConfigurationDataError::Resources)?;
        let row = rows
            .get_mut(&key(session.as_str()))
            .expect("same original SID row");
        let frozen = crate::session_resources_v2::decode(row)
            .map_err(PoolConfigurationDataError::Resources)?;
        let replacement = if let Some(frozen) = frozen {
            let memory =
                memory_policies::session(frozen.memory.as_ref(), employee, policy, memory)?;
            crate::session_resources_v2::wrap(resource_fields(&resources, policy)?, Some(memory))
        } else {
            Value(Node::Object(resource_fields(&resources, policy)?))
        };
        *row = replacement;
    }
    Ok(())
}
