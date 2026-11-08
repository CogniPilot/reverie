//! Nonblocking late settlement of ORIGINAL native producers. No new query,
//! stop request, outcome reset, resource return or release proof is produced.
use super::*;
impl WorkerRuntime {
    pub fn settle_laptop_native_for_handler(&self, workflow: &LaptopWorkflow) -> Result<()> {
        let workflows = self.laptop_workflows();
        workflows.bound(self, workflow)?;
        let now = Instant::now();
        let end = self.stop_deadline().map_or(now, |stop| stop.min(now));
        workflows.settle_record(self, &workflow.record, end)
    }
    pub fn settle_existing_native_for_handler(&self, existing: &ExistingViewer) -> Result<()> {
        self.laptop_workflows()
            .bound_existing(self, &existing.reference)?;
        let now = Instant::now();
        let end = self.stop_deadline().map_or(now, |stop| stop.min(now));
        existing_viewer::settle_retained(self, &existing.reference.record, end)
    }
}
