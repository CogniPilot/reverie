//! Post-memory cold phase on the SAME actual laptop resource record. Enabled
//! strategies require their real transaction; absent policy never bypasses a
//! pending fence, resource binding, stop or the original supplied deadline.
use super::*;
use reverie_contracts::worker_validation::WorkerValidationData;

#[must_use = "retain the actual record through pane/checked cleanup"]
pub struct ColdCommitted {
    pub(super) workflow: LaptopWorkflow,
}
impl ColdCommitted {
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
#[must_use = "refusal or uncertainty retains the same started resources"]
pub enum ColdCommit {
    Committed(ColdCommitted),
    Rejected,
    Retained,
}
impl Workflows {
    fn commit_cold(
        &self,
        runtime: &WorkerRuntime,
        configured: &ConfiguredMemory,
        deadline: Instant,
    ) -> Result<ColdCommit> {
        self.bound(runtime, &configured.workflow)?;
        let mut record = configured
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record.outcome.as_ref().is_some_and(|value| value.is_ok())
                && record
                    .creation
                    .as_ref()
                    .is_some_and(|value| value.stage == create::CreateStage::MemoryConfigured),
            "WORKER_LAPTOP_COLD_PHASE",
        )?;
        // Consume this one-shot phase before any operation that can fail.
        record
            .creation
            .as_mut()
            .expect("known configured memory")
            .stage = create::CreateStage::CommittingCold;
        record.phase = Phase::Running;
        let result = commit(runtime, &record, deadline);
        record.unknown |= result.as_ref().is_err_and(LaptopError::unconfirmed_native);
        record.outcome = Some(result.map_err(Arc::new));
        if record.pending.is_some() || record.unknown {
            record.phase = Phase::Retained;
            return Ok(ColdCommit::Retained);
        }
        record.phase = Phase::Known;
        if record.outcome.as_ref().expect("cold outcome").is_err() {
            return Ok(ColdCommit::Rejected);
        }
        record.creation.as_mut().expect("known cold outcome").stage =
            create::CreateStage::ColdCommitted;
        Ok(ColdCommit::Committed(ColdCommitted {
            workflow: configured.workflow.clone(),
        }))
    }
}
impl WorkerRuntime {
    /// Only a genuine successful same-record memory phase reaches this owner.
    /// No request/configuration value can manufacture the returned phase token.
    pub fn commit_started_laptop_cold(
        &self,
        configured: &ConfiguredMemory,
        deadline: Instant,
    ) -> Result<ColdCommit> {
        self.laptop_workflows()
            .commit_cold(self, configured, deadline)
    }
}
fn commit(runtime: &WorkerRuntime, record: &Record, deadline: Instant) -> Result<()> {
    running(runtime, deadline)?;
    let resources = record.resources();
    resources
        .nix
        .assert_create_plan(runtime, &resources.plan)
        .map_err(LaptopError::Plan)?;
    resources
        .nix
        .assert_cold_resources_current()
        .map_err(LaptopError::Nix)?;
    if WorkerValidationData::new(resources.plan.source())
        .cold()
        .map_err(LaptopError::ColdPolicy)?
        .is_some()
    {
        // This first bounded increment implements the real absent-policy
        // phase only. Never mint enabled-policy success without its actual
        // clear/retained transaction carried by the same storage owner.
        return Err(LaptopError::Refused("WORKER_COLD_TRANSACTION_REQUIRED"));
    }
    resources
        .nix
        .assert_cold_resources_current()
        .map_err(LaptopError::Nix)?;
    running(runtime, deadline)
}
fn running(runtime: &WorkerRuntime, supplied: Instant) -> Result<()> {
    let end = runtime
        .stop_deadline()
        .map_or(supplied, |stop| supplied.min(stop));
    need(Instant::now() < end, "WORKER_COLD_DEADLINE")?;
    need(
        !runtime.cancellation().is_cancelled(),
        "WORKER_LAPTOP_STOPPED",
    )
}
