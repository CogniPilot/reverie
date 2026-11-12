//! Each canonical admission phase borrows the actual installed controller.
//! Final create effects retain their own uninterrupted borrow of that owner.
use super::*;
use reverie_contracts::worker_pool::WorkerPoolProvider;
use reverie_host::worker_launch::ObservedCreatePlan;

impl InstallingBroker {
    pub(in crate::installing_broker) fn check_creation_budget_for_plan_locked(
        &self,
        lifecycle: &LaptopLifecycle<'_>,
        plan: &ObservedCreatePlan,
        resources: &EffectiveWorkerConfig,
        admission: Option<&OrdinaryLaunchAdmission>,
    ) -> Result<()> {
        let source = self.configuration()?;
        let provider = WorkerPoolProvider::from_config(source.configuration())
            .map_err(|_| CreationBudgetError::Refused("WORKER_POOL_PROVIDER_INVALID"))?;
        if provider.is_none() {
            return self.check_creation_budget_locked(
                lifecycle,
                plan.session(),
                resources,
                admission,
            );
        }
        let mut controller = self.borrow_controller_for_creation()?;
        let mut member = controller.prepare_member(plan, Installed(&self.storage.runtime).end())?;
        member.assert_configuration(source.configuration(), resources, plan.session())?;
        self.check_creation_budget_selected_locked(
            lifecycle,
            plan.session(),
            resources,
            admission,
            Some(&mut member),
        )
    }
}
