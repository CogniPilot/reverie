//! Actual post-copy removal over SAME successful Nix resources. Stop outcome
//! DATA cannot reconstruct the private old-target owner or this record proof.
use super::*;
use crate::{
    worker_launch::ObservedCreatePlan,
    worker_source_stop::{SourceStopError, StoppedLaptopRemoval},
};
#[derive(Default)]
pub(super) enum RemovalState {
    #[default]
    Unattempted,
    Attempted,
    Confirmed(Arc<()>),
    Failed,
}
#[must_use = "carry the same actual post-Nix result through the original cold continuation"]
pub struct RemovedStoppedLaptop {
    workflow: NixWorkflow,
    identity: Arc<()>,
}
impl RemovedStoppedLaptop {
    /// A current same-record check, never a raw ID/ready flag or global release.
    pub fn assert_workflow(&self, runtime: &WorkerRuntime, workflow: &NixWorkflow) -> Result<()> {
        runtime.nix_workflows().bound(runtime, workflow)?;
        need(
            self.workflow.same_workflow(workflow),
            NixFault::RuntimeBinding,
        )?;
        let record = workflow
            .record
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        need(
            record.phase == Phase::Known
                && !record.turn
                && matches!(&record.outcome, Some(Ok(_)))
                && matches!(&record.stopped_removal,RemovalState::Confirmed(identity) if Arc::ptr_eq(identity,&self.identity)),
            NixFault::Retained,
        )?;
        record.resources().guard.assert_current()
    }
}
impl Workflows {
    fn remove_stopped_laptop(
        &self,
        runtime: &WorkerRuntime,
        workflow: &NixWorkflow,
        plan: &ObservedCreatePlan,
        removal: &mut StoppedLaptopRemoval,
        deadline: Option<Instant>,
    ) -> Result<RemovedStoppedLaptop> {
        self.bound(runtime, workflow)?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        need(
            record.phase == Phase::Known
                && !record.turn
                && matches!(&record.outcome, Some(Ok(_)))
                && matches!(record.stopped_removal, RemovalState::Unattempted),
            NixFault::Retained,
        )?;
        need(workflow.session() == plan.session(), NixFault::StoreBinding)?;
        removal
            .assert_binding(runtime, &record.resources().storage, plan)
            .map_err(|error| NixError::StoppedRemoval(Arc::new(error)))?;
        record.resources().guard.assert_current()?;
        record.stopped_removal = RemovalState::Attempted;
        record.phase = Phase::Running;
        let result = removal
            .attempt(runtime, &mut record.pending_call, deadline)
            .map_err(|error| NixError::StoppedRemoval(Arc::new(error)))
            .and_then(|()| record.resources().guard.assert_current())
            .and_then(|()| {
                plan.assert_storage_owner(runtime, &record.resources().storage)
                    .map_err(|error| {
                        NixError::StoppedRemoval(Arc::new(SourceStopError::Plan(error)))
                    })
            });
        match result {
            Ok(()) => {
                removal.confirmed();
                let identity = removal.identity().clone();
                record.stopped_removal = RemovalState::Confirmed(identity.clone());
                record.phase = Phase::Known;
                Ok(RemovedStoppedLaptop {
                    workflow: workflow.clone(),
                    identity,
                })
            }
            Err(error) => {
                removal.rejected();
                record.stopped_removal = RemovalState::Failed;
                // Even known local query cleanup cannot forgive a failed rm,
                // restarted target or lost result. The SAME ticket and actual
                // Box/guard remain in this counted Nix record, never replayed.
                record.unknown_effect = true;
                record.note(error);
                record.phase = Phase::Retained;
                Err(NixError::Refused(NixFault::Retained))
            }
        }
    }
}
impl WorkerRuntime {
    pub fn remove_stopped_laptop_after_nix(
        &self,
        workflow: &NixWorkflow,
        plan: &ObservedCreatePlan,
        removal: &mut StoppedLaptopRemoval,
        end: Instant,
    ) -> Result<RemovedStoppedLaptop> {
        self.nix_workflows()
            .remove_stopped_laptop(self, workflow, plan, removal, Some(end))
    }
    /// Original worker purpose: no aggregate body cap, each fixed query20s
    /// clipped to live first-stop. App has reacquired/rechecked its actual cold
    /// lifecycle/current policy/writers/budget; this method supplies no grant.
    pub fn remove_stopped_laptop_after_nix_for_worker(
        &self,
        workflow: &NixWorkflow,
        plan: &ObservedCreatePlan,
        removal: &mut StoppedLaptopRemoval,
    ) -> Result<RemovedStoppedLaptop> {
        self.nix_workflows()
            .remove_stopped_laptop(self, workflow, plan, removal, None)
    }
}
