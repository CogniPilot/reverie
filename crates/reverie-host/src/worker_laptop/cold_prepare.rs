//! Same-record post-network/pre-create cold operation. Enabled clear runs its
//! actual transaction; retention requires its pre-Office owned preparation.
use super::*;
#[derive(Default, Eq, PartialEq)]
pub(super) enum Stage {
    #[default]
    NotStarted,
    Preparing,
    Prepared,
}
#[must_use = "retain the actual laptop record through creation/cleanup"]
pub struct PreparedColdTemporary {
    workflow: LaptopWorkflow,
}
impl PreparedColdTemporary {
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
#[must_use = "refused/unknown preparation never authorizes creation"]
pub enum ColdPreparation {
    Prepared(PreparedColdTemporary),
    Rejected,
    Retained,
}
impl WorkerRuntime {
    pub fn prepare_laptop_cold_temporary(
        &self,
        workflow: &LaptopWorkflow,
        deadline: Instant,
    ) -> Result<ColdPreparation> {
        self.laptop_workflows()
            .prepare_cold(self, workflow, deadline)
    }
}
impl Workflows {
    fn prepare_cold(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        deadline: Instant,
    ) -> Result<ColdPreparation> {
        self.bound(runtime, workflow)?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record.outcome.as_ref().is_some_and(|value| value.is_ok())
                && record.creation.is_none()
                && record.cold == Stage::NotStarted,
            "WORKER_LAPTOP_COLD_PREPARATION_PHASE",
        )?;
        record.cold = Stage::Preparing;
        record.phase = Phase::Running;
        let result = (|| {
            super::cold::running(runtime, deadline)?;
            let resources = record.resources.as_mut().expect("actual network resources");
            let guard::NixOwnership::Held(nix) = &mut resources.nix else {
                return Err(LaptopError::Refused("WORKER_LAPTOP_NIX_GUARD_CONSUMED"));
            };
            nix.prepare_laptop_cold_temporary(runtime, &resources.plan, deadline)?;
            super::cold::running(runtime, deadline)
        })();
        record.unknown |= result.as_ref().is_err_and(LaptopError::unconfirmed_native);
        record.outcome = Some(result.map_err(Arc::new));
        if record.pending.is_some() || record.unknown {
            record.phase = Phase::Retained;
            return Ok(ColdPreparation::Retained);
        }
        record.phase = Phase::Known;
        if record
            .outcome
            .as_ref()
            .expect("actual cold result")
            .is_err()
        {
            return Ok(ColdPreparation::Rejected);
        }
        record.cold = Stage::Prepared;
        Ok(ColdPreparation::Prepared(PreparedColdTemporary {
            workflow: workflow.clone(),
        }))
    }
}
