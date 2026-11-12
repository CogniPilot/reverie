use super::*;
use crate::worker_launch::ObservedPlanIdentity;
use reverie_contracts::{
    reservation_engine::ObservedMemoryPolicy,
    storage_identity::MetadataText,
    worker_config::{WorkerConfigDigest, config_digest},
    worker_pool::WorkerPoolProvider,
};
use reverie_core::{
    decimal::UnsignedInteger,
    resources::{BudgetMode, ResourcePolicy},
};

pub(super) struct PlanBinding {
    identity: ObservedPlanIdentity,
    source: WorkerConfigDigest,
    effective: WorkerConfigDigest,
    session: ProfileSessionId,
    resources: ResourcePolicy,
}
impl PlanBinding {
    pub(super) fn capture(
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
        controller: &ActivatedController,
    ) -> PoolResult<Self> {
        pool_need(plan.same_runtime(runtime), "WORKER_POOL_CREATE_RUNTIME")?;
        let policy = controller.policy_data();
        let source = selected(plan.source())?;
        controller.assert_member_policy_provider(&source)?;
        let effective = selected(plan.effective_configuration())?;
        pool_need(
            effective.policy() == policy && effective.member_revision() == 0,
            "WORKER_POOL_CREATE_PROVIDER_CHANGED",
        )?;
        let resources = reverie_contracts::resource_config::checked_effective_policy(
            plan.effective_configuration(),
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_CREATE_RESOURCES"))?;
        let employee = plan
            .storage()
            .employee()
            .ok_or(PoolError::Refused("WORKER_POOL_EMPLOYEE_REQUIRED"))?;
        let high = policy
            .employee_memory_high_mi_b
            .get(employee.as_str())
            .ok_or(PoolError::Refused("WORKER_POOL_CREATE_EMPLOYEE"))?;
        resources_current(&resources, plan.effective_configuration(), policy, *high)?;
        arguments(plan.arguments().args(), policy, &resources)?;
        Ok(Self {
            identity: plan.original_observation(),
            source: config_digest(plan.source()),
            effective: config_digest(plan.effective_configuration()),
            session: plan.session().clone(),
            resources,
        })
    }
    pub(super) fn assert_plan(
        &self,
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
    ) -> PoolResult<()> {
        pool_need(
            plan.same_runtime(runtime) && plan.matches_observation(&self.identity),
            "WORKER_POOL_CREATE_PLAN_CHANGED",
        )?;
        self.assert_configuration(
            plan.source(),
            plan.effective_configuration(),
            plan.session(),
        )
    }
    pub(super) fn assert_configuration(
        &self,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        effective: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> PoolResult<()> {
        pool_need(
            self.source == config_digest(source)
                && self.effective == config_digest(effective)
                && &self.session == session,
            "WORKER_POOL_CREATE_CONFIGURATION_CHANGED",
        )
    }
    pub(super) fn resources(&self) -> &ResourcePolicy {
        &self.resources
    }
    pub(super) fn session(&self) -> &ProfileSessionId {
        &self.session
    }
}
fn selected(
    config: &reverie_contracts::worker_config::EffectiveWorkerConfig,
) -> PoolResult<WorkerPoolProvider> {
    WorkerPoolProvider::from_config(config)
        .map_err(|_| PoolError::Refused("WORKER_POOL_PROVIDER_INVALID"))?
        .ok_or(PoolError::Refused("WORKER_POOL_CREATE_PROVIDER_CHANGED"))
}
fn resources_current(
    resources: &ResourcePolicy,
    effective: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    policy: &reverie_contracts::worker_pool::WorkerPoolPolicy,
    high: u32,
) -> PoolResult<()> {
    let memory = ObservedMemoryPolicy::from_effective(effective)
        .map_err(|_| PoolError::Refused("WORKER_POOL_CREATE_RESOURCES"))?;
    pool_need(
        resources.budget_mode() == BudgetMode::Pool
            && resources.memory_mib() == policy.memory_max_mi_b
            && resources.pool_memory_mib() == policy.memory_max_mi_b
            && resources.pool_tasks_max() == policy.pool_tasks_max
            && resources.cpus().nano_cpus() == 0
            && (64..=4096).contains(&resources.pids_limit())
            && memory.as_ref().is_some_and(|memory| {
                memory.uses_pool()
                    && memory.swap().is_zero()
                    && memory.high()
                        == Some(&UnsignedInteger::from_u64(u64::from(high) * 1_048_576))
            }),
        "WORKER_POOL_CREATE_RESOURCES",
    )
}
pub(super) fn arguments(
    args: &[MetadataText],
    policy: &reverie_contracts::worker_pool::WorkerPoolPolicy,
    resources: &ResourcePolicy,
) -> PoolResult<()> {
    for (flag, value) in [
        ("--cgroup-parent", policy.parent_slice()),
        ("--memory", format!("{}m", policy.memory_max_mi_b)),
        ("--memory-swap", format!("{}m", policy.memory_max_mi_b)),
        ("--pids-limit", resources.pids_limit().to_string()),
    ] {
        let positions = args
            .iter()
            .enumerate()
            .filter(|(_, arg)| equals(arg, flag))
            .map(|(at, _)| at)
            .collect::<Vec<_>>();
        pool_need(
            positions.len() == 1
                && args
                    .get(positions[0] + 1)
                    .is_some_and(|arg| equals(arg, &value)),
            "WORKER_POOL_CREATE_ARGUMENTS",
        )?;
    }
    pool_need(
        !args.iter().any(|arg| {
            ["--cpus", "--cpu-quota", "--cpu-period"]
                .iter()
                .any(|flag| equals(arg, flag))
        }),
        "WORKER_POOL_CREATE_CPU_QUOTA",
    )
}
fn equals(value: &MetadataText, expected: &str) -> bool {
    value
        .codepoints()
        .iter()
        .copied()
        .eq(expected.chars().map(u32::from))
}
