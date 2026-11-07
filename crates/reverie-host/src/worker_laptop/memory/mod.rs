//! One-shot started-container memory phase over the actual retained workflow.
//! Completion is local to memory; it is not CLI readiness or cold-storage ACK.
mod helper;
mod target;
mod worker;
pub(super) use worker::Pending;
pub(super) use worker::close_abandoned;
pub use worker::{
    StartedMemoryPolicy, StartedMemoryReadback, WorkerMemoryBegin, WorkerMemoryEffect,
};
#[cfg(test)]
mod tests;
use super::call_budget::CallBudget;
use super::*;
use crate::reservation_kernel::ReservationKernel;
use reverie_contracts::{
    reservation_engine::ObservedMemoryPolicy,
    worker_recovery::{RecoveryInspection, RecoveryInspectionNeed},
    worker_validation::WorkerValidationData,
};
use std::time::Duration;

#[must_use = "retain the same container and original resources until checked stop"]
pub struct ConfiguredMemory {
    pub(super) workflow: LaptopWorkflow,
}
impl ConfiguredMemory {
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
#[must_use = "refusal or uncertainty retains the actual started resource record"]
pub enum MemoryConfiguration {
    Configured(ConfiguredMemory),
    Rejected,
    Retained,
}
impl Workflows {
    fn configure_memory(
        &self,
        runtime: &WorkerRuntime,
        started: &StartedContainer,
        deadline: Instant,
        observed: &impl Observations,
    ) -> Result<MemoryConfiguration> {
        self.bound(runtime, &started.workflow)?;
        let mut record = started
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record.creation.as_ref().is_some_and(|state| {
                    state.stage == create::CreateStage::Started
                        && state.container.as_ref() == started.container_id()
                }),
            "WORKER_LAPTOP_MEMORY_PHASE",
        )?;
        record
            .creation
            .as_mut()
            .expect("actual started record")
            .stage = create::CreateStage::ConfiguringMemory;
        record.phase = Phase::Running;
        let result = run(runtime, &mut record, deadline, observed);
        record.unknown |= result.as_ref().is_err_and(LaptopError::unconfirmed_native);
        record.outcome = Some(result.map_err(Arc::new));
        if record.pending.is_some() || record.unknown {
            record.phase = Phase::Retained;
            return Ok(MemoryConfiguration::Retained);
        }
        record.phase = Phase::Known;
        if record.outcome.as_ref().expect("memory outcome").is_err() {
            return Ok(MemoryConfiguration::Rejected);
        }
        record
            .creation
            .as_mut()
            .expect("actual memory record")
            .stage = create::CreateStage::MemoryConfigured;
        Ok(MemoryConfiguration::Configured(ConfiguredMemory {
            workflow: started.workflow.clone(),
        }))
    }
}
impl WorkerRuntime {
    /// Requires the actual successful start over the same runtime/resource record.
    /// Source/effective config, name, SID and canonical CID are never supplied by callers.
    pub fn configure_started_laptop_memory(
        &self,
        started: &StartedContainer,
        deadline: Instant,
    ) -> Result<MemoryConfiguration> {
        self.laptop_workflows()
            .configure_memory(self, started, deadline, &Installed)
    }
}
trait Observations {
    fn host_root(&self, deadline: Instant) -> Result<()>;
    fn target(&self, pid: u32) -> Result<target::Target>;
    fn limits(
        &self,
        row: &RecoveryInspection,
        policy: &ObservedMemoryPolicy,
        deadline: Instant,
    ) -> Result<()>;
    fn limits_selected(
        &self,
        row: &RecoveryInspection,
        policy: Option<&ObservedMemoryPolicy>,
        deadline: Instant,
    ) -> Result<()> {
        match policy {
            Some(policy) => self.limits(row, policy, deadline),
            None => ReservationKernel::new()
                .verify_recovery_limits(row, None, deadline)
                .map_err(LaptopError::MemoryKernel),
        }
    }
}
struct Installed;
impl Observations for Installed {
    fn host_root(&self, deadline: Instant) -> Result<()> {
        ReservationKernel::new()
            .host_root(deadline)
            .map(|_| ())
            .map_err(LaptopError::MemoryKernel)
    }
    fn target(&self, pid: u32) -> Result<target::Target> {
        target::Target::open(pid)
    }
    fn limits(
        &self,
        row: &RecoveryInspection,
        policy: &ObservedMemoryPolicy,
        deadline: Instant,
    ) -> Result<()> {
        ReservationKernel::new()
            .verify_recovery_limits(row, Some(policy), deadline)
            .map_err(LaptopError::MemoryKernel)
    }
}
fn run(
    runtime: &WorkerRuntime,
    record: &mut Record,
    deadline: Instant,
    observed: &impl Observations,
) -> Result<()> {
    // Even the no-I/O path consumes a real one-shot lifecycle phase. Local
    // cancellation and the original supplied/stop budget fence its success.
    let deadline = runtime
        .stop_deadline()
        .map_or(deadline, |stop| stop.min(deadline));
    running(runtime, deadline)?;
    let config = record.resources().plan.effective_configuration();
    let Some(policy) =
        ObservedMemoryPolicy::from_effective(config).map_err(LaptopError::MemoryData)?
    else {
        return Ok(()); // Preserve the absent-policy path: no kernel/engine/helper/write effects.
    };
    observed.host_root(deadline)?;
    let row = inspect(runtime, record, deadline)?;
    let target = target_from_row(
        runtime,
        record,
        &row,
        record.resources().plan.arguments().policy_digest(),
        observed,
    )?;
    let mut attempted = false;
    let effect = enforce(
        runtime,
        record,
        &row,
        &target,
        &policy,
        deadline,
        &mut attempted,
    )
    .and_then(|()| observed.limits(&row, &policy, deadline))
    .and_then(|()| refresh(runtime, record, &row, &target, deadline));
    let result = finalized(effect, target.close());
    classify(result, attempted)
}
fn target_from_row(
    runtime: &WorkerRuntime,
    record: &Record,
    row: &RecoveryInspection,
    wanted: &reverie_contracts::worker_config::WorkerPolicyDigest,
    observed: &impl Observations,
) -> Result<target::Target> {
    let plan = &record.resources().plan;
    let cid = record
        .creation
        .as_ref()
        .and_then(|state| state.container.as_ref())
        .ok_or(LaptopError::Refused("LAPTOP_MEMORY_CANONICAL_CID_REQUIRED"))?;
    let pid = row
        .started_memory_pid(
            plan.arguments().name(),
            runtime.worker_identity().deployment(),
            plan.session(),
            cid,
            wanted,
        )
        .map_err(LaptopError::MemoryIdentity)?;
    observed.target(pid)
}
fn enforce(
    runtime: &WorkerRuntime,
    record: &mut Record,
    row: &RecoveryInspection,
    target: &target::Target,
    policy: &ObservedMemoryPolicy,
    deadline: Instant,
    attempted: &mut bool,
) -> Result<()> {
    target.fences()?;
    same(runtime, record, row, deadline)?;
    let Some(high) = policy.high() else {
        return Ok(());
    };
    let plan = &record.resources().plan;
    let selected = WorkerValidationData::new(plan.source())
        .soft_limit_helper()
        .map_err(LaptopError::MemoryHelperSelection)?;
    if let Some(path) = selected {
        let path = crate::native::python_path(path.codepoints()).map_err(LaptopError::Io)?;
        let session = plan.session().clone();
        let cid = record
            .creation
            .as_ref()
            .and_then(|state| state.container.clone())
            .expect("strict inspected canonical CID");
        running(runtime, deadline)?;
        helper::request(
            &path,
            &session,
            &cid,
            high,
            deadline.min(Instant::now() + Duration::from_secs(10)),
            attempted,
        )?;
    } else {
        // Slow engine equality first, then fresh local fences, hard ceiling and
        // original deadline immediately before the one fixed writer open.
        direct_high(
            runtime,
            record,
            row,
            target,
            policy,
            CallBudget::bounded(deadline),
            attempted,
        )?;
    }
    Ok(())
}
fn direct_high(
    runtime: &WorkerRuntime,
    record: &mut Record,
    row: &RecoveryInspection,
    target: &target::Target,
    policy: &ObservedMemoryPolicy,
    budget: CallBudget,
    attempted: &mut bool,
) -> Result<()> {
    let high = policy.high().expect("selected high");
    refresh_with_budget(runtime, record, row, target, budget)?;
    target.hard_is(policy.memory().as_str())?;
    running_budget(runtime, budget)?;
    target.write_high(high.as_str(), budget.end(runtime, 30), attempted)?;
    refresh_with_budget(runtime, record, row, target, budget)?;
    target.high_is(high.as_str())?;
    target.hard_is(policy.memory().as_str())
}
fn classify<T>(result: Result<T>, attempted: bool) -> Result<T> {
    match result {
        Err(error) if attempted => Err(LaptopError::MemoryEffectUnconfirmed(Box::new(error))),
        other => other,
    }
}
fn inspect(
    runtime: &WorkerRuntime,
    record: &mut Record,
    deadline: Instant,
) -> Result<RecoveryInspection> {
    inspect_with_budget(runtime, record, CallBudget::bounded(deadline))
}
fn inspect_with_budget(
    runtime: &WorkerRuntime,
    record: &mut Record,
    budget: CallBudget,
) -> Result<RecoveryInspection> {
    running_budget(runtime, budget)?;
    let name = record.resources().plan.arguments().name().to_owned();
    let output = network::call_with_budget(
        runtime,
        record,
        vec!["inspect".into(), name.clone().into()],
        network::CallPurpose::Observe,
        budget,
    )?;
    let out = std::str::from_utf8(&output.stdout)
        .map_err(|_| LaptopError::Refused("LAPTOP_MEMORY_INSPECT_ENCODING"))?;
    let err = std::str::from_utf8(&output.stderr)
        .map_err(|_| LaptopError::Refused("LAPTOP_MEMORY_INSPECT_ENCODING"))?;
    match RecoveryInspection::inspect_data(&name, out, err, output.shell_code)
        .map_err(LaptopError::MemoryIdentity)?
    {
        RecoveryInspectionNeed::Present(row) => Ok(row),
        RecoveryInspectionNeed::ConfirmAbsence => {
            Err(LaptopError::Refused("LAPTOP_MEMORY_TARGET_ABSENT"))
        }
    }
}
fn same(
    runtime: &WorkerRuntime,
    record: &mut Record,
    row: &RecoveryInspection,
    deadline: Instant,
) -> Result<()> {
    need(
        row.same_memory_observation(&inspect(runtime, record, deadline)?),
        "LAPTOP_MEMORY_ENGINE_CHANGED",
    )
}
fn refresh(
    runtime: &WorkerRuntime,
    record: &mut Record,
    row: &RecoveryInspection,
    target: &target::Target,
    deadline: Instant,
) -> Result<()> {
    refresh_with_budget(runtime, record, row, target, CallBudget::bounded(deadline))
}
fn refresh_with_budget(
    runtime: &WorkerRuntime,
    record: &mut Record,
    row: &RecoveryInspection,
    target: &target::Target,
    budget: CallBudget,
) -> Result<()> {
    same_with_budget(runtime, record, row, budget)?;
    target.fences()
}
fn same_with_budget(
    runtime: &WorkerRuntime,
    record: &mut Record,
    row: &RecoveryInspection,
    budget: CallBudget,
) -> Result<()> {
    need(
        row.same_memory_observation(&inspect_with_budget(runtime, record, budget)?),
        "LAPTOP_MEMORY_ENGINE_CHANGED",
    )
}
fn running_budget(runtime: &WorkerRuntime, budget: CallBudget) -> Result<()> {
    budget.check(runtime)?;
    need(
        !runtime.cancellation().is_cancelled(),
        "WORKER_LAPTOP_STOPPED",
    )
}
fn check(deadline: Instant) -> Result<()> {
    need(Instant::now() < deadline, "LAPTOP_MEMORY_DEADLINE")
}
fn running(runtime: &WorkerRuntime, deadline: Instant) -> Result<()> {
    check(deadline)?;
    need(
        !runtime.cancellation().is_cancelled(),
        "WORKER_LAPTOP_STOPPED",
    )?;
    if let Some(stop) = runtime.stop_deadline() {
        check(stop)?;
    }
    Ok(())
}
