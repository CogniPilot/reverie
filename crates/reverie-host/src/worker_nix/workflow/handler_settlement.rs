//! Exact original Nix workflow only, using an already-expired observation
//! ceiling. Original cleanup stages/deadlines remain; no new submission window.
use super::*;
use crate::worker_runtime::{NativeSettlementProgress, settlement::pending};
impl WorkerRuntime {
    pub fn settle_nix_native_for_handler(
        &self,
        workflow: &NixWorkflow,
    ) -> Result<NativeSettlementProgress> {
        let workflows = self.nix_workflows();
        if let Err(error) = workflows.bound(self, workflow) {
            return progress(Err(error));
        }
        let now = Instant::now();
        let end = self.stop_deadline().map_or(now, |stop| stop.min(now));
        progress(workflows.settle_record(self, &workflow.record, end))
    }
}
fn progress(result: Result<()>) -> Result<NativeSettlementProgress> {
    match result {
        Ok(()) => Ok(NativeSettlementProgress::Settled),
        Err(error) if pending_nix(&error) => Ok(NativeSettlementProgress::Pending),
        Err(error) => Err(error),
    }
}
fn pending_nix(error: &NixError) -> bool {
    match error {
        NixError::Refused(NixFault::Retained | NixFault::Busy) => true,
        NixError::Engine(error) => pending(error),
        NixError::Finalization { primary, secondary } => {
            pending_nix(primary) && pending_nix(secondary)
        }
        _ => false,
    }
}
