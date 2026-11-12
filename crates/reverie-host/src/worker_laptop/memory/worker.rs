//! Actual worker's fresh-policy joins. Opened targets stay in the existing
//! laptop record across App policy reads; no row/ID can construct these tokens.
use super::*;
use crate::worker_reports::WorkerLaunchConnection;
use reverie_contracts::worker_config::{EffectiveWorkerConfig, WorkerPolicyDigest};
mod controller;
mod effect;
mod readback;
mod state;
/// Borrowed phase services; the actual resources remain in the laptop record.
struct ObservationStep<'a, O> {
    runtime: &'a WorkerRuntime,
    facts: &'a O,
    budget: CallBudget,
}
#[cfg(test)]
mod tests;
pub(in crate::worker_laptop) enum Pending {
    Policy {
        row: RecoveryInspection,
        policy: ObservedMemoryPolicy,
        budget: CallBudget,
    },
    Readback {
        row: RecoveryInspection,
        target: target::Target,
        attempted: bool,
        controller_policy: Option<reverie_contracts::worker_pool::WorkerPoolMemberPolicy>,
        budget: CallBudget,
    },
}
pub(in crate::worker_laptop) fn close_abandoned(record: &mut Record) -> Result<()> {
    let Some(pending) = record
        .creation
        .as_mut()
        .and_then(|creation| creation.worker_memory.take())
    else {
        return Ok(());
    };
    let (attempted, closed) = match pending {
        Pending::Policy { .. } => (false, Ok(())),
        Pending::Readback {
            target, attempted, ..
        } => (attempted, target.close()),
    };
    let closed = classify(closed, attempted);
    let failure = match closed {
        Err(error) => error,
        Ok(()) if attempted => LaptopError::MemoryEffectUnconfirmed(Box::new(
            LaptopError::Refused("LAPTOP_MEMORY_PHASE_ABANDONED"),
        )),
        Ok(()) => {
            record.outcome = Some(Err(Arc::new(LaptopError::Refused(
                "LAPTOP_MEMORY_PHASE_ABANDONED",
            ))));
            return Ok(());
        }
    };
    record.unknown |= failure.unconfirmed_native();
    let failure = Arc::new(failure);
    record.outcome = Some(Err(failure.clone()));
    Err(LaptopError::Recorded(failure))
}
enum RejectStage {
    Policy,
    Readback,
}
pub struct StartedMemoryPolicy {
    workflow: LaptopWorkflow,
}
pub struct StartedMemoryReadback {
    workflow: LaptopWorkflow,
}
pub enum WorkerMemoryBegin {
    Configured(ConfiguredMemory),
    Policy(StartedMemoryPolicy),
    Rejected,
    Retained,
}
pub enum WorkerMemoryEffect {
    Readback(StartedMemoryReadback),
    Rejected,
    Retained,
}
impl WorkerRuntime {
    /// `resources` is the actual App's fresh effective DATA at this phase.
    /// The raw configured enable branch is checked against the retained plan.
    pub fn begin_started_laptop_memory_for_connection(
        &self,
        started: &StartedContainer,
        connection: &WorkerLaunchConnection,
        resources: Option<&EffectiveWorkerConfig>,
    ) -> Result<WorkerMemoryBegin> {
        self.laptop_workflows()
            .begin_worker_memory(self, started, connection, resources, &Installed)
    }
    pub fn apply_started_laptop_memory_for_connection(
        &self,
        observed: &StartedMemoryPolicy,
        connection: &WorkerLaunchConnection,
        policy: &WorkerPolicyDigest,
    ) -> Result<WorkerMemoryEffect> {
        self.laptop_workflows()
            .apply_worker_memory(self, observed, connection, policy, &Installed)
    }
    pub fn finish_started_laptop_memory_for_connection(
        &self,
        observed: &StartedMemoryReadback,
        connection: &WorkerLaunchConnection,
        resources: &EffectiveWorkerConfig,
        policy: Option<&WorkerPolicyDigest>,
    ) -> Result<MemoryConfiguration> {
        self.laptop_workflows()
            .finish_worker_memory(self, observed, connection, resources, policy, &Installed)
    }
    pub fn reject_started_laptop_memory_policy_for_connection(
        &self,
        observed: &StartedMemoryPolicy,
        connection: &WorkerLaunchConnection,
    ) -> Result<MemoryConfiguration> {
        self.laptop_workflows().assert_worker_cleanup_connection(
            self,
            &observed.workflow,
            connection,
        )?;
        self.laptop_workflows()
            .reject_worker_memory(self, &observed.workflow, RejectStage::Policy)
    }
    pub fn reject_started_laptop_memory_readback_for_connection(
        &self,
        observed: &StartedMemoryReadback,
        connection: &WorkerLaunchConnection,
    ) -> Result<MemoryConfiguration> {
        self.laptop_workflows().assert_worker_cleanup_connection(
            self,
            &observed.workflow,
            connection,
        )?;
        self.laptop_workflows().reject_worker_memory(
            self,
            &observed.workflow,
            RejectStage::Readback,
        )
    }
}
impl Workflows {
    fn begin_worker_memory(
        &self,
        runtime: &WorkerRuntime,
        started: &StartedContainer,
        connection: &WorkerLaunchConnection,
        resources: Option<&EffectiveWorkerConfig>,
        observed: &impl Observations,
    ) -> Result<WorkerMemoryBegin> {
        self.assert_worker_connection(runtime, &started.workflow, connection)?;
        let mut record = state::started(&started.workflow)?;
        need(
            record
                .creation
                .as_ref()
                .and_then(|creation| creation.container.as_ref())
                == started.container_id(),
            "WORKER_LAPTOP_MEMORY_PHASE",
        )?;
        record.creation.as_mut().expect("actual start").stage =
            create::CreateStage::ConfiguringMemory;
        record.phase = Phase::Running;
        let result = (|| {
            running_budget(runtime, CallBudget::worker())?;
            let enabled = reverie_contracts::device_policy::memory::resource_projection_required(
                record.resources().plan.source(),
            );
            need(
                enabled == resources.is_some(),
                "LAPTOP_MEMORY_SOURCE_SELECTION",
            )?;
            let policy = resources
                .map(ObservedMemoryPolicy::from_effective)
                .transpose()
                .map_err(LaptopError::MemoryData)?
                .flatten();
            let Some(policy) = policy else {
                return Ok(None);
            };
            observed.host_root(CallBudget::worker().end(runtime, 30))?;
            let row = inspect_with_budget(runtime, &mut record, CallBudget::worker())?;
            Ok(Some(Pending::Policy {
                row,
                policy,
                budget: CallBudget::worker(),
            }))
        })();
        match result {
            Ok(Some(pending)) => {
                record
                    .creation
                    .as_mut()
                    .expect("actual memory")
                    .worker_memory = Some(pending);
                record.outcome = Some(Ok(()));
                record.phase = Phase::Known;
                Ok(WorkerMemoryBegin::Policy(StartedMemoryPolicy {
                    workflow: started.workflow.clone(),
                }))
            }
            Ok(None) => Ok(
                match state::complete(&mut record, &started.workflow, Ok(())) {
                    MemoryConfiguration::Configured(value) => WorkerMemoryBegin::Configured(value),
                    MemoryConfiguration::Rejected => WorkerMemoryBegin::Rejected,
                    MemoryConfiguration::Retained => WorkerMemoryBegin::Retained,
                },
            ),
            Err(error) => Ok(
                match state::complete(&mut record, &started.workflow, Err(error)) {
                    MemoryConfiguration::Rejected => WorkerMemoryBegin::Rejected,
                    _ => WorkerMemoryBegin::Retained,
                },
            ),
        }
    }
    fn reject_worker_memory(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        expected: RejectStage,
    ) -> Result<MemoryConfiguration> {
        self.bound(runtime, workflow)?;
        let mut record = state::pending(workflow)?;
        need(
            matches!(
                (
                    &expected,
                    record
                        .creation
                        .as_ref()
                        .expect("actual memory")
                        .worker_memory
                        .as_ref()
                ),
                (RejectStage::Policy, Some(Pending::Policy { .. }))
                    | (RejectStage::Readback, Some(Pending::Readback { .. }))
            ),
            "LAPTOP_MEMORY_POLICY_PHASE",
        )?;
        let pending = record
            .creation
            .as_mut()
            .expect("actual memory")
            .worker_memory
            .take()
            .ok_or(LaptopError::Refused("LAPTOP_MEMORY_PHASE_CONSUMED"))?;
        record.phase = Phase::Running;
        let result = state::fail(
            pending,
            LaptopError::Refused("LAPTOP_MEMORY_POLICY_UNAVAILABLE"),
        );
        Ok(state::complete(&mut record, workflow, result))
    }
}
