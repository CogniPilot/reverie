//! Nonblocking late settlement of ORIGINAL native producers. No new query,
//! stop request, outcome reset, resource return or release proof is produced.
use super::*;
use crate::worker_runtime::{NativeSettlementProgress, settlement::pending};
impl WorkerRuntime {
    pub fn settle_laptop_native_for_handler(
        &self,
        workflow: &LaptopWorkflow,
    ) -> Result<NativeSettlementProgress> {
        let workflows = self.laptop_workflows();
        if let Err(error) = workflows.bound(self, workflow) {
            return progress(Err(error));
        }
        let now = Instant::now();
        let end = self.stop_deadline().map_or(now, |stop| stop.min(now));
        progress(workflows.settle_record(self, &workflow.record, end))
    }
    pub fn settle_existing_native_for_handler(
        &self,
        existing: &ExistingViewer,
    ) -> Result<NativeSettlementProgress> {
        if let Err(error) = self
            .laptop_workflows()
            .bound_existing(self, &existing.reference)
        {
            return progress(Err(error));
        }
        let now = Instant::now();
        let end = self.stop_deadline().map_or(now, |stop| stop.min(now));
        progress(existing_viewer::settle_retained(
            self,
            &existing.reference.record,
            end,
        ))
    }
}
fn progress(result: Result<()>) -> Result<NativeSettlementProgress> {
    match result {
        Ok(()) => Ok(NativeSettlementProgress::Settled),
        Err(error) if pending_laptop(&error) => Ok(NativeSettlementProgress::Pending),
        Err(error) => Err(error),
    }
}
fn pending_laptop(error: &LaptopError) -> bool {
    match error {
        LaptopError::Refused(code) => matches!(
            *code,
            "WORKER_LAPTOP_RETAINED"
                | "WORKER_EXISTING_VIEWER_RETAINED"
                | "WORKER_EXISTING_VIEWER_STORAGE_HELD"
                | "WORKER_STARTED_FINAL_STORAGE_RETAINED"
        ),
        LaptopError::Engine(error) => pending(error),
        LaptopError::Finalization { primary, secondary } => {
            pending_laptop(primary) && pending_laptop(secondary)
        }
        _ => false,
    }
}
