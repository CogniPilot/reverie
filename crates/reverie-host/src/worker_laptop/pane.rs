//! Fixed native tmux pane phase after the same record's memory and cold commit.
//! Two native acknowledgements are not admission release or broker registration.
use super::*;
use reverie_contracts::worker_launch::{pane_start_arguments, pane_status_arguments};
use reverie_core::worker_launch::ContainerReference;

/// Both fixed tmux commands succeeded on this actual retained resource record.
/// No serialized status, CID, nonce or name can construct this token. The
/// application must still publish its real CLI-started/released transitions.
#[must_use = "retain the actual pane and all resources until checked stop"]
pub struct StartedPane {
    pub(super) workflow: LaptopWorkflow,
}
impl StartedPane {
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
#[must_use = "retain the original record on refused or uncertain pane work"]
pub enum PaneStart {
    Started(StartedPane),
    Rejected,
    Retained,
}
impl Workflows {
    fn start_pane(
        &self,
        runtime: &WorkerRuntime,
        cold: &ColdCommitted,
        deadline: Instant,
    ) -> Result<PaneStart> {
        self.bound(runtime, &cold.workflow)?;
        let mut record = cold
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record.pending.is_none()
                && !record.unknown
                && record.outcome.as_ref().is_some_and(|result| result.is_ok())
                && record.creation.as_ref().is_some_and(|state| {
                    state.stage == create::CreateStage::ColdCommitted
                        && state
                            .publication
                            .as_ref()
                            .is_some_and(publication::Publication::confirmed)
                }),
            "WORKER_LAPTOP_PANE_PHASE",
        )?;
        record.creation.as_mut().expect("actual cold record").stage =
            create::CreateStage::StartingPane;
        record.phase = Phase::Running;
        let result = run(runtime, &mut record, deadline);
        record.outcome = Some(result.map_err(Arc::new));
        if record.pending.is_some() || record.unknown {
            record.phase = Phase::Retained;
            return Ok(PaneStart::Retained);
        }
        record.phase = Phase::Known;
        if record
            .outcome
            .as_ref()
            .expect("actual pane result")
            .is_err()
        {
            return Ok(PaneStart::Rejected);
        }
        let creation = record.creation.as_mut().expect("actual pane record");
        creation.stage = create::CreateStage::PaneStarted;
        Ok(PaneStart::Started(StartedPane {
            workflow: cold.workflow.clone(),
        }))
    }
}
fn run(runtime: &WorkerRuntime, record: &mut Record, deadline: Instant) -> Result<()> {
    // Derive BOTH commands before the first client; every input belongs to
    // the same successful publication and request, with no caller argv/path.
    let resources = record.resources();
    let name = ContainerReference::Worker(resources.plan.arguments().worker_name());
    let nonce = record
        .creation
        .as_ref()
        .expect("actual creation")
        .publication
        .as_ref()
        .expect("confirmed publication")
        .nonce();
    let start = pane_start_arguments(&name, nonce, resources.request.terminal());
    let status = pane_status_arguments(&name);
    call(runtime, record, start, deadline)?;
    // Even a known local refusal of the second constructor leaves a real
    // pane from the first invocation. Keep that effect uncertainty sticky.
    record.unknown = true;
    call(runtime, record, status, deadline)?;
    record.unknown = false;
    Ok(())
}
fn call(
    runtime: &WorkerRuntime,
    record: &mut Record,
    arguments: Vec<reverie_contracts::storage_identity::MetadataText>,
    deadline: Instant,
) -> Result<()> {
    let argv = network::encode_arguments(&arguments)?;
    let output = network::call(
        runtime,
        record,
        argv,
        network::CallPurpose::Launch,
        deadline,
    )?;
    if !output.succeeded {
        record.unknown = true;
        return Err(LaptopError::Refused("WORKER_LAPTOP_PANE_UNCONFIRMED"));
    }
    Ok(())
}
impl WorkerRuntime {
    /// Runs the original new-session/remain-on-exit command and then status-off
    /// only after a genuine same-record cold commit. No shell wrapper is used:
    /// the existing worker child owns the fixed --pane-exit receipt lifecycle.
    pub fn start_laptop_pane(&self, cold: &ColdCommitted, deadline: Instant) -> Result<PaneStart> {
        self.laptop_workflows().start_pane(self, cold, deadline)
    }
}
