//! Read the original installed parent's creation counters. This is a budget
//! prerequisite, not an admission, membership or provider-activation grant.
use super::*;
use reverie_contracts::creation_budget::{CreationBudgetError, check_pool_counters};
use reverie_core::resources::{BudgetMode, ResourcePolicy};

impl ActivatedController {
    pub fn check_creation_pool(
        &mut self,
        runtime: &WorkerRuntime,
        resources: &ResourcePolicy,
        require_headroom: bool,
        end: Instant,
    ) -> Result<()> {
        let policy = self.policy_data();
        if resources.budget_mode() != BudgetMode::Pool
            || resources.pool_memory_mib() != policy.memory_max_mi_b
            || resources.pool_tasks_max() != policy.pool_tasks_max
        {
            return Err(PoolError::CreationBudget(
                CreationBudgetError::PoolActivation,
            ));
        }
        let owner = self.state_mut();
        owner.require_no_member_policy_edit()?;
        need(
            std::sync::Arc::ptr_eq(&owner.binding.engine, runtime.installed_engine()),
            "WORKER_POOL_BROKER_RUNTIME_CHANGED",
        )?;
        let end = owner
            .binding
            .stop
            .deadline()
            .map_or(end, |stop| end.min(stop));
        check_end(owner, end)?;
        let observed =
            owner
                .creation_pool_counters(runtime, end)
                .and_then(|(memory, tasks, current)| {
                    check_pool_counters(
                        &memory,
                        &tasks,
                        &current,
                        u64::from(owner.policy.memory_max_mi_b) * 1_048_576,
                        owner.policy.pool_tasks_max,
                        require_headroom,
                    )
                    .map_err(PoolError::CreationBudget)
                });
        match observed {
            Ok(()) => Ok(()),
            Err(PoolError::CreationBudget(CreationBudgetError::TaskHeadroom)) => {
                Err(PoolError::CreationBudget(CreationBudgetError::TaskHeadroom))
            }
            Err(PoolError::CreationDeadline) => Err(PoolError::CreationDeadline),
            Err(error) => {
                owner.retain_native_error(error);
                Err(PoolError::Refused("WORKER_POOL_CREATION_BUDGET_RETAINED"))
            }
        }
    }
}

impl ControllerState {
    fn creation_pool_counters(
        &mut self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<(String, String, String)> {
        self.assert_current(runtime, end)?;
        let memory = read_counter(self, "memory.max", end)?;
        let tasks = read_counter(self, "pids.max", end)?;
        let current = read_counter(self, "pids.current", end)?;
        self.assert_current(runtime, end)?;
        check_end(self, end)?;
        Ok((memory, tasks, current))
    }
}

fn read_counter(owner: &ControllerState, name: &str, end: Instant) -> Result<String> {
    check_end(owner, end)?;
    let value = directory::read_at(owner.directory.parent()?, name)?;
    check_end(owner, end)?;
    Ok(value)
}

fn check_end(owner: &ControllerState, end: Instant) -> Result<()> {
    owner.require_active()?;
    let end = owner
        .binding
        .stop
        .deadline()
        .map_or(end, |stop| end.min(stop));
    if Instant::now() < end {
        Ok(())
    } else {
        Err(PoolError::CreationDeadline)
    }
}
