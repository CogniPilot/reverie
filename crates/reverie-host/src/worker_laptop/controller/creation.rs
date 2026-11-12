//! A prospective member remains borrowed from the original native controller
//! through actual create/start/configure. It grants no Gate or owner consent.
use super::*;
use crate::worker_pool::ControllerCapacity;
use reverie_contracts::{
    reservation_engine::NativeLimitBinding, worker_config::EffectiveWorkerConfig,
};
use reverie_core::resources::ResourcePolicy;
mod effects;
mod plan;
use plan::PlanBinding;
type PoolResult<T> = std::result::Result<T, PoolError>;

#[must_use = "keep the same controller borrow through admission and native member effects"]
pub struct PoolMemberCreation<'controller> {
    controller: &'controller mut ActivatedController,
    plan: PlanBinding,
    end: Instant,
}
impl ActivatedController {
    pub fn prepare_member_creation(
        &mut self,
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> PoolResult<PoolMemberCreation<'_>> {
        let end = runtime.stop_deadline().map_or(end, |stop| stop.min(end));
        pool_need(Instant::now() < end, "WORKER_POOL_MEMBER_CREATION_DEADLINE")?;
        let plan = PlanBinding::capture(runtime, plan, self)?;
        let current = self.assert_current(runtime, end);
        self.retain_member_result(current)?;
        Ok(PoolMemberCreation {
            controller: self,
            plan,
            end,
        })
    }
    pub fn prepare_workflow_member_creation(
        &mut self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        connection: &WorkerLaunchConnection,
        end: Instant,
    ) -> PoolResult<PoolMemberCreation<'_>> {
        let end = runtime.stop_deadline().map_or(end, |stop| stop.min(end));
        pool_need(Instant::now() < end, "WORKER_POOL_MEMBER_CREATION_DEADLINE")?;
        let plan = workflow_plan(self, runtime, workflow, connection)?;
        let current = self.assert_current(runtime, end);
        self.retain_member_result(current)?;
        Ok(PoolMemberCreation {
            controller: self,
            plan,
            end,
        })
    }
}
impl PoolMemberCreation<'_> {
    pub fn assert_plan(
        &mut self,
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
    ) -> PoolResult<()> {
        self.plan.assert_plan(runtime, plan)?;
        self.check_current(runtime)
    }
    pub fn assert_configuration(
        &mut self,
        runtime: &WorkerRuntime,
        source: &EffectiveWorkerConfig,
        effective: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> PoolResult<()> {
        self.plan.assert_configuration(source, effective, session)?;
        self.check_current(runtime)
    }
    pub fn session(&self) -> &ProfileSessionId {
        self.plan.session()
    }
    pub fn resources_data(&self) -> &ResourcePolicy {
        self.plan.resources()
    }
    pub fn observe_capacity(
        &mut self,
        website: &NativeLimitBinding,
        supplied_end: Instant,
    ) -> PoolResult<ControllerCapacity<'_>> {
        pool_need(
            Instant::now() < self.end.min(supplied_end),
            "WORKER_POOL_MEMBER_CREATION_DEADLINE",
        )?;
        self.controller
            .observe_member_capacity(website, self.end.min(supplied_end))
    }
    fn check_current(&mut self, runtime: &WorkerRuntime) -> PoolResult<()> {
        let end = runtime
            .stop_deadline()
            .map_or(self.end, |stop| self.end.min(stop));
        pool_need(Instant::now() < end, "WORKER_POOL_MEMBER_CREATION_DEADLINE")?;
        let result = self.controller.assert_current(runtime, end);
        self.controller.retain_member_result(result)
    }
    pub(in crate::worker_laptop) fn assert_arguments(
        &mut self,
        runtime: &WorkerRuntime,
        observed: &ObservedCreatePlan,
        arguments: &[reverie_contracts::storage_identity::MetadataText],
    ) -> PoolResult<()> {
        self.plan.assert_plan(runtime, observed)?;
        plan::arguments(
            arguments,
            self.controller.policy_data(),
            self.plan.resources(),
        )?;
        self.check_current(runtime)
    }
}
fn workflow_plan(
    controller: &mut ActivatedController,
    runtime: &WorkerRuntime,
    workflow: &LaptopWorkflow,
    connection: &WorkerLaunchConnection,
) -> PoolResult<PlanBinding> {
    runtime
        .laptop_workflows()
        .assert_worker_cleanup_connection(runtime, workflow, connection)
        .map_err(|_| PoolError::Refused("WORKER_POOL_CREATED_CONNECTION"))?;
    let mut record = workflow
        .record
        .try_lock()
        .map_err(|_| PoolError::Refused("WORKER_POOL_CREATED_RETAINED"))?;
    if let Some(Err(error)) = &record.outcome {
        if record.pending.is_some() || record.unknown || error.unconfirmed_native() {
            controller.retain_member_cause(PoolError::Member(error.clone()));
        }
        return Err(PoolError::Member(error.clone()));
    }
    pool_need(
        record.phase == Phase::Known
            && !record.unknown
            && record.creation.is_none()
            && record
                .outcome
                .as_ref()
                .is_some_and(|outcome| outcome.is_ok()),
        "WORKER_POOL_CREATE_PHASE",
    )?;
    match connection_progress(&mut record) {
        Err(PoolError::Channel(error)) => {
            return controller.retain_member_result(Err(PoolError::Channel(error)));
        }
        other => other?,
    }
    let resources = record
        .resources
        .as_ref()
        .ok_or(PoolError::Refused("WORKER_POOL_CREATED_RESOURCES_RETURNED"))?;
    PlanBinding::capture(runtime, &resources.plan, controller)
}
fn pool_need(value: bool, code: &'static str) -> PoolResult<()> {
    value.then_some(()).ok_or(PoolError::Refused(code))
}
fn connection_progress(record: &mut Record) -> PoolResult<()> {
    let original = record
        .resources
        .as_ref()
        .and_then(|resources| resources.connection.as_ref())
        .ok_or(PoolError::Refused("WORKER_POOL_CREATED_CONNECTION"))?;
    match original.observe_progress().map_err(PoolError::Channel)? {
        Some(true) => return Ok(()),
        None => return Err(PoolError::Refused("WORKER_POOL_CREATED_PENDING")),
        Some(false) => {}
    }
    if record.phase == Phase::Known
        && !record.unknown
        && record.pending.is_none()
        && record
            .outcome
            .as_ref()
            .is_some_and(|outcome| outcome.is_ok())
    {
        let error = Arc::new(LaptopError::Refused("WORKER_LAPTOP_CONNECTION_CHANGED"));
        record.outcome = Some(Err(error.clone()));
        return Err(PoolError::Member(error));
    }
    if let Some(Err(error)) = &record.outcome {
        return Err(PoolError::Member(error.clone()));
    }
    Err(PoolError::Refused("WORKER_POOL_CREATED_RETAINED"))
}
pub(in crate::worker_laptop) fn check_member(
    runtime: &WorkerRuntime,
    plan: &ObservedCreatePlan,
    member: Option<&mut PoolMemberCreation<'_>>,
) -> std::result::Result<(), LaptopError> {
    let provider = reverie_contracts::worker_pool::WorkerPoolProvider::from_config(plan.source())
        .map_err(|_| LaptopError::Refused("WORKER_POOL_PROVIDER_INVALID"))?;
    match member {
        Some(member) => member.assert_plan(runtime, plan).map_err(super::pool_error),
        None => need(
            provider.is_none(),
            "WORKER_POOL_PROVIDER_MAINTENANCE_REQUIRED",
        ),
    }
}
pub(in crate::worker_laptop) fn retain_outcome(
    member: Option<&mut PoolMemberCreation<'_>>,
    record: &Record,
) {
    if let (Some(member), Some(Err(error))) = (member, &record.outcome) {
        // Known employee refusal before a native effect stays local. Only the
        // original record's actual pending/unknown state or intrinsic native
        // uncertainty can fence the shared controller for this workflow error.
        if record.pending.is_some() || record.unknown || error.unconfirmed_native() {
            member
                .controller
                .retain_member_cause(PoolError::Member(error.clone()));
        }
    }
}
