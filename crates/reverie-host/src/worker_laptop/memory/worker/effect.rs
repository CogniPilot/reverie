//! Source's outer target remains open; a direct high write owns a distinct
//! inner target and closes it before the App performs readback-policy reads.
use super::*;
impl Workflows {
    pub(super) fn apply_worker_memory(
        &self,
        runtime: &WorkerRuntime,
        observed: &StartedMemoryPolicy,
        connection: &WorkerLaunchConnection,
        wanted: &WorkerPolicyDigest,
        facts: &impl Observations,
    ) -> Result<WorkerMemoryEffect> {
        let (mut record, row, policy, budget) = begin_effect(self, runtime, observed, connection)?;
        let result = effect(runtime, &mut record, row, policy, wanted, budget, facts);
        finish_effect(&mut record, &observed.workflow, result)
    }
}
type EffectInput<'a> = (
    std::sync::MutexGuard<'a, Record>,
    RecoveryInspection,
    ObservedMemoryPolicy,
    CallBudget,
);
pub(super) fn begin_effect<'a>(
    workflows: &Workflows,
    runtime: &WorkerRuntime,
    observed: &'a StartedMemoryPolicy,
    connection: &WorkerLaunchConnection,
) -> Result<EffectInput<'a>> {
    workflows.assert_worker_connection(runtime, &observed.workflow, connection)?;
    let mut record = state::pending(&observed.workflow)?;
    need(
        matches!(
            record
                .creation
                .as_ref()
                .expect("actual memory")
                .worker_memory,
            Some(Pending::Policy { .. })
        ),
        "LAPTOP_MEMORY_POLICY_PHASE",
    )?;
    let Some(Pending::Policy {
        row,
        policy,
        budget,
    }) = record
        .creation
        .as_mut()
        .expect("actual memory")
        .worker_memory
        .take()
    else {
        unreachable!("checked same policy phase");
    };
    record.phase = Phase::Running;
    Ok((record, row, policy, budget))
}
pub(super) fn finish_effect(
    record: &mut Record,
    workflow: &LaptopWorkflow,
    result: Result<Pending>,
) -> Result<WorkerMemoryEffect> {
    match result {
        Ok(pending) => {
            record
                .creation
                .as_mut()
                .expect("actual memory")
                .worker_memory = Some(pending);
            record.phase = Phase::Known;
            record.outcome = Some(Ok(()));
            Ok(WorkerMemoryEffect::Readback(StartedMemoryReadback {
                workflow: workflow.clone(),
            }))
        }
        Err(error) => Ok(match state::complete(record, workflow, Err(error)) {
            MemoryConfiguration::Rejected => WorkerMemoryEffect::Rejected,
            _ => WorkerMemoryEffect::Retained,
        }),
    }
}
fn effect(
    runtime: &WorkerRuntime,
    record: &mut Record,
    row: RecoveryInspection,
    policy: ObservedMemoryPolicy,
    wanted: &WorkerPolicyDigest,
    budget: CallBudget,
    facts: &impl Observations,
) -> Result<Pending> {
    running_budget(runtime, budget)?;
    let outer = target_from_row(runtime, record, &row, wanted, facts)?;
    let mut attempted = false;
    let result = write(
        &ObservationStep {
            runtime,
            facts,
            budget,
        },
        record,
        &row,
        &outer,
        &policy,
        &mut attempted,
    )
    .and_then(|()| {
        row.fields_for_limits()
            .map_err(LaptopError::MemoryData)?
            .running_header()
            .map_err(LaptopError::MemoryData)
    });
    match result {
        Ok(()) => Ok(Pending::Readback {
            row,
            target: outer,
            attempted,
            controller_policy: None,
            budget,
        }),
        Err(primary) => classify(finalized(Err(primary), outer.close()), attempted),
    }
}
fn write(
    step: &ObservationStep<'_, impl Observations>,
    record: &mut Record,
    row: &RecoveryInspection,
    outer: &target::Target,
    policy: &ObservedMemoryPolicy,
    attempted: &mut bool,
) -> Result<()> {
    let ObservationStep {
        runtime,
        facts,
        budget,
    } = *step;
    outer.fences()?;
    same_with_budget(runtime, record, row, budget)?;
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
            .expect("strict actual Created CID");
        running_budget(runtime, budget)?;
        return helper::request(
            &path,
            &session,
            &cid,
            high,
            budget.end(runtime, 10),
            attempted,
        );
    }
    // Like A.apply_high, capture the second real target AFTER outer fences and
    // equality; its close is a distinct checked finalizer before readback.
    let inner = facts.target(outer.process_id())?;
    let result = direct_high(runtime, record, row, &inner, policy, budget, attempted);
    finalized(result, inner.close())
}
