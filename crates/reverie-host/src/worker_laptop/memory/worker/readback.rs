//! Fresh actual App readback selection/digest precede physical limits. The
//! original outer target closes on every path after the final fence/equality.
use super::*;
impl Workflows {
    pub(super) fn finish_worker_memory(
        &self,
        runtime: &WorkerRuntime,
        observed: &StartedMemoryReadback,
        connection: &WorkerLaunchConnection,
        resources: &EffectiveWorkerConfig,
        digest: Option<&WorkerPolicyDigest>,
        facts: &impl Observations,
    ) -> Result<MemoryConfiguration> {
        self.assert_worker_connection(runtime, &observed.workflow, connection)?;
        let mut record = state::pending(&observed.workflow)?;
        need(
            matches!(
                record
                    .creation
                    .as_ref()
                    .expect("actual memory")
                    .worker_memory,
                Some(Pending::Readback { .. })
            ),
            "LAPTOP_MEMORY_READBACK_PHASE",
        )?;
        let Some(Pending::Readback {
            row,
            target,
            attempted,
            controller_policy,
            budget,
        }) = record
            .creation
            .as_mut()
            .expect("actual memory")
            .worker_memory
            .take()
        else {
            unreachable!("checked readback owner")
        };
        record.phase = Phase::Running;
        let result = finish(
            &ObservationStep {
                runtime,
                facts,
                budget,
            },
            &mut record,
            &row,
            &target,
            resources,
            digest,
            controller_policy,
        );
        let result = classify(finalized(result, target.close()), attempted);
        Ok(state::complete(&mut record, &observed.workflow, result))
    }
}
fn finish(
    step: &ObservationStep<'_, impl Observations>,
    record: &mut Record,
    row: &RecoveryInspection,
    target: &target::Target,
    resources: &EffectiveWorkerConfig,
    digest: Option<&WorkerPolicyDigest>,
    controller_policy: Option<reverie_contracts::worker_pool::WorkerPoolMemberPolicy>,
) -> Result<()> {
    let ObservationStep {
        runtime,
        facts,
        budget,
    } = *step;
    running_budget(runtime, budget)?;
    let policy =
        ObservedMemoryPolicy::from_effective(resources).map_err(LaptopError::MemoryData)?;
    need(
        policy.is_some() == digest.is_some(),
        "LAPTOP_MEMORY_READBACK_SELECTION",
    )?;
    if let Some(policy) = &policy {
        let fields = row.fields_for_limits().map_err(LaptopError::MemoryData)?;
        need(
            fields
                .label_is(
                    "reverie.worker-policy",
                    &digest.expect("selected digest").to_hex(),
                )
                .map_err(LaptopError::MemoryData)?
                && fields
                    .memory_matches(policy.memory())
                    .map_err(LaptopError::MemoryData)?,
            "RESERVATION_SOURCE_POLICY",
        )?;
    }
    let physical = match controller_policy {
        Some(settings) => Some(
            policy
                .ok_or(LaptopError::Refused("LAPTOP_CONTROLLER_MEMORY_POLICY"))?
                .with_pool_member_policy(settings)
                .map_err(LaptopError::MemoryData)?,
        ),
        None => policy,
    };
    facts.limits_selected(row, physical.as_ref(), budget.end(runtime, 30))?;
    // Unlike a pre-write refresh, original configure_started's final check is
    // outer fences FIRST, followed by the slow same-engine row comparison.
    target.fences()?;
    same_with_budget(runtime, record, row, budget)
}
