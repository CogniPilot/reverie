//! Consume the actual controller's same-Created result through the existing
//! memory readback phase. The controller write is never repeated here.
use super::*;
use crate::worker_laptop::ControllerMemberConfigured;

impl WorkerRuntime {
    pub fn accept_controller_memory_for_connection(
        &self,
        observed: &StartedMemoryPolicy,
        configured: ControllerMemberConfigured,
        connection: &WorkerLaunchConnection,
        digest: &WorkerPolicyDigest,
    ) -> Result<WorkerMemoryEffect> {
        // Validate the affine original before taking its workflow record lock.
        configured.assert_memory(self, &observed.workflow, connection, digest)?;
        let (mut record, row, policy, budget) =
            effect::begin_effect(self.laptop_workflows(), self, observed, connection)?;
        let result = accept_readback(
            self,
            &mut record,
            row,
            policy,
            digest,
            budget,
            configured.settings(),
        );
        effect::finish_effect(&mut record, &observed.workflow, result)
    }
}
fn accept_readback(
    runtime: &WorkerRuntime,
    record: &mut Record,
    row: RecoveryInspection,
    policy: ObservedMemoryPolicy,
    digest: &WorkerPolicyDigest,
    budget: CallBudget,
    controller_policy: reverie_contracts::worker_pool::WorkerPoolMemberPolicy,
) -> Result<Pending> {
    // Any refusal is after the original controller effect; preserve that
    // distinction in the existing memory outcome and cleanup state.
    let captured = running_budget(runtime, budget).and_then(|()| {
        need(
            policy.uses_pool() && policy.high().is_some(),
            "LAPTOP_CONTROLLER_MEMORY_POLICY",
        )?;
        target_from_row(runtime, record, &row, digest, &Installed)
    });
    let outer = match captured {
        Ok(target) => target,
        Err(error) => return classify(Err(error), true),
    };
    let checked = outer
        .fences()
        .and_then(|()| same_with_budget(runtime, record, &row, budget))
        .and_then(|()| {
            row.fields_for_limits()
                .map_err(LaptopError::MemoryData)?
                .running_header()
                .map_err(LaptopError::MemoryData)
        });
    match checked {
        Ok(()) => Ok(Pending::Readback {
            row,
            target: outer,
            attempted: true,
            controller_policy: Some(controller_policy),
            budget,
        }),
        Err(error) => classify(finalized(Err(error), outer.close()), true),
    }
}
