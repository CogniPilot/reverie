//! Prospective member accounting requires the actual borrowed create owner.
//! Ordinary hard charges and retained operation deltas stay unchanged.
use super::*;
use crate::installing_broker::InstalledMemberCreation;
use reverie_contracts::{resource_config, worker_config, worker_pool::WorkerPoolProvider};

impl OrdinaryLaunchAdmission {
    pub(crate) fn check_member_creation(
        &self,
        member: &mut InstalledMemberCreation<'_>,
    ) -> Result<HeadroomFacts> {
        self.gate.require_host_job_idle()?;
        self.gate.check_ordinary_launch(&self.session)?;
        let config = self.gate.config()?;
        let effective = crate::resource_staging::effective_config(
            config.configuration().clone(),
            &self.session,
        )?;
        let provider = WorkerPoolProvider::from_config(config.configuration())
            .map_err(|_| GateError::Refused("RESERVATION_POOL_PROVIDER_INVALID"))?
            .ok_or(GateError::Refused("RESERVATION_POOL_PROVIDER_REQUIRED"))?;
        let resources = resource_config::checked_effective_policy(&effective)?;
        need(
            resources.budget_mode() == BudgetMode::Pool
                && resources.memory_mib() == provider.policy().memory_max_mi_b
                && config.pool_bytes()?
                    == reverie_core::decimal::UnsignedInteger::from_u64(
                        u64::from(provider.policy().memory_max_mi_b) * 1_048_576,
                    ),
            "RESERVATION_POOL_CANDIDATE_POLICY",
        )?;
        member
            .assert_configuration(config.configuration(), &effective, &self.session)
            .map_err(|error| GateError::Refused(error.code()))?;
        let rows = self.gate.guard(None)?;
        let native = self.gate.native_context()?;
        let capacity = native.member_creation_capacity(&rows, member)?;
        let retained = self.gate.retained_delta(&self.gate.document()?)?;
        let budget = CapacityCounter::from_integer(capacity.budget())?;
        let committed = CapacityCounter::from_integer(capacity.total())?;
        let retained = CapacityCounter::from_integer(&retained)?;
        need(
            pool_headroom_fits(budget, committed, retained, CapacityCounter::try_new(0)?)?,
            "RESERVATION_CAPACITY_EXHAUSTED",
        )?;
        need(
            native.inventory(None)?.equivalent(&rows),
            "RESERVATION_NATIVE_INVENTORY_CHANGED",
        )?;
        member
            .assert_configuration(config.configuration(), &effective, &self.session)
            .map_err(|error| GateError::Refused(error.code()))?;
        need(
            worker_config::equivalent(self.gate.config()?.configuration(), config.configuration()),
            "RESERVATION_POOL_CREATION_PLAN_CHANGED",
        )?;
        Ok(HeadroomFacts {
            budget_bytes: budget.get(),
            committed_bytes: committed.get(),
            retained_bytes: retained.get(),
        })
    }
}
