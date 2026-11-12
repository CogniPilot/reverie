use super::*;
use reverie_contracts::worker_pool::{ControllerServiceBirth, WorkerPoolMemberPolicy};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct MemberPolicies(BTreeMap<String, WorkerPoolMemberPolicy>);

impl MemberPolicies {
    pub(super) fn from_birth(birth: Option<&ControllerServiceBirth>) -> (Self, u64) {
        birth
            .and_then(ControllerServiceBirth::member_snapshot)
            .map_or_else(
                || (Self::default(), 0),
                |snapshot| (Self(snapshot.overrides().clone()), snapshot.revision()),
            )
    }

    pub(super) fn overrides(&self) -> &BTreeMap<String, WorkerPoolMemberPolicy> {
        &self.0
    }

    pub(super) fn effective(
        &self,
        birth: &WorkerPoolPolicy,
        employee: &str,
    ) -> Result<WorkerPoolMemberPolicy> {
        self.0
            .get(employee)
            .copied()
            .map_or_else(|| birth_policy(birth, employee), Ok)
    }

    pub(super) fn commit(
        &mut self,
        birth: &WorkerPoolPolicy,
        employee: &str,
        next: WorkerPoolMemberPolicy,
    ) -> Result<()> {
        if next == birth_policy(birth, employee)? {
            self.0.remove(employee);
        } else {
            self.0.insert(employee.to_owned(), next);
        }
        Ok(())
    }
}

pub(super) fn birth_policy(
    birth: &WorkerPoolPolicy,
    employee: &str,
) -> Result<WorkerPoolMemberPolicy> {
    let high = *birth
        .employee_memory_high_mi_b
        .get(employee)
        .ok_or(PoolError::Refused("WORKER_POOL_MEMBER_EMPLOYEE"))?;
    WorkerPoolMemberPolicy::new(high, birth.cpu_weight)
        .map_err(|_| PoolError::Refused("WORKER_POOL_MEMBER_POLICY"))
}
