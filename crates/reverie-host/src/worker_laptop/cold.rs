//! Post-memory cold phase on the SAME actual laptop resource record. Enabled
//! strategies require their real transaction; absent policy never bypasses a
//! pending fence, resource binding, stop or the original supplied deadline.
use super::call_budget::CallBudget;
use super::*;

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
        deadline: CallBudget,
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
        let result = commit(runtime, &mut record, deadline);
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
            .commit_cold(self, configured, CallBudget::bounded(deadline))
    }
    pub fn commit_started_laptop_cold_for_connection(
        &self,
        configured: &ConfiguredMemory,
        connection: &crate::worker_reports::WorkerLaunchConnection,
    ) -> Result<ColdCommit> {
        self.laptop_workflows()
            .assert_worker_connection(self, &configured.workflow, connection)?;
        self.laptop_workflows()
            .commit_cold(self, configured, CallBudget::worker())
    }
}
fn commit(runtime: &WorkerRuntime, record: &mut Record, deadline: CallBudget) -> Result<()> {
    running_budget(runtime, deadline)?;
    let resources = record.resources();
    let retained = matches!(
        reverie_contracts::worker_cold_tmp::ColdConfiguration::capture(resources.plan.source())
            .map_err(|error| LaptopError::ColdStorage(
                crate::worker_storage::StorageOwnerError::ColdData(error)
            ))?
            .as_ref()
            .map(reverie_contracts::worker_cold_tmp::ColdConfiguration::strategy),
        Some(reverie_contracts::worker_cold_tmp::ColdStrategy::RetainAndReplace)
    );
    resources
        .held_nix()?
        .assert_create_plan(runtime, &resources.plan)
        .map_err(LaptopError::Plan)?;
    resources
        .held_nix()?
        .assert_cold_resources_current()
        .map_err(LaptopError::Nix)?;
    resources
        .held_nix()?
        .require_cold_prepared(resources.plan.source())?;
    // The selected task-v2 path must finish its actual same-Created perf check
    // before any cold commit can produce a token accepted by pane startup.
    super::perf::check(runtime, record, deadline)?;
    if retained {
        return commit_retained(runtime, record, deadline);
    }
    let resources = record.resources();
    resources
        .held_nix()?
        .assert_cold_resources_current()
        .map_err(LaptopError::Nix)?;
    running_budget(runtime, deadline)
}
fn commit_retained(
    runtime: &WorkerRuntime,
    record: &mut Record,
    supplied: CallBudget,
) -> Result<()> {
    // Source's first canonical confirmation precedes the commit's nominal
    // 30-second window. The original supplied/stop deadline still bounds it.
    let first = super::cold_confirm::confirm(runtime, record, supplied)?;
    let deadline = supplied.end(runtime, 30);
    {
        let resources = record
            .resources
            .as_mut()
            .expect("actual retained laptop resources");
        let guard::NixOwnership::Held(nix) = &mut resources.nix else {
            return Err(LaptopError::Refused("WORKER_LAPTOP_NIX_GUARD_CONSUMED"));
        };
        nix.begin_retained_cold_commit(resources.plan.source(), &first, deadline)?;
    }
    // Bound publication and every local finalizer have completed. Re-observe
    // the SAME actual Created CID; no caller-supplied native assertion exists.
    let second = super::cold_confirm::confirm(runtime, record, CallBudget::bounded(deadline))?;
    let resources = record.resources();
    resources
        .held_nix()?
        .assert_create_plan(runtime, &resources.plan)
        .map_err(LaptopError::Plan)?;
    resources
        .held_nix()?
        .assert_cold_resources_current()
        .map_err(LaptopError::Nix)?;
    running(runtime, deadline)?;
    let resources = record
        .resources
        .as_mut()
        .expect("actual retained laptop resources");
    let guard::NixOwnership::Held(nix) = &mut resources.nix else {
        return Err(LaptopError::Refused("WORKER_LAPTOP_NIX_GUARD_CONSUMED"));
    };
    // The named owner checks its actual guard BEFORE final fence removal.
    // No fallible call occurs after this release in this caller.
    nix.release_retained_cold_commit(resources.plan.source(), &second, deadline)
}
pub(super) fn running(runtime: &WorkerRuntime, supplied: Instant) -> Result<()> {
    running_budget(runtime, CallBudget::bounded(supplied))
}
pub(super) fn running_budget(runtime: &WorkerRuntime, budget: CallBudget) -> Result<()> {
    budget
        .check(runtime)
        .map_err(|_| LaptopError::Refused("WORKER_COLD_DEADLINE"))?;
    need(
        !runtime.cancellation().is_cancelled(),
        "WORKER_LAPTOP_STOPPED",
    )
}
