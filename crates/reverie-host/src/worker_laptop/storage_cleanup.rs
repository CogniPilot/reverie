//! Cleanup of the original actual Nix guard is independent of successful
//! create/pane readiness. No synthetic NixReturned or release proof is minted.
use super::*;
use crate::worker_reports::WorkerLaunchConnection;
impl Workflows {
    fn cleanup_nix_guard(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        ceiling: Option<Instant>,
    ) -> Result<()> {
        self.bound(runtime, workflow)?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        // Terminal before any fallible local finalizer; ordinary forward paths
        // can no longer run while the actual guard changes sum variants.
        need(record.resources.is_some(), "WORKER_LAPTOP_REPLAYED")?;
        if !matches!(record.phase, Phase::Stopped | Phase::CleanupRetained) {
            record.phase = Phase::Cleaning;
        }
        if matches!(
            record.resources().nix,
            guard::NixOwnership::GuardConsumed(_)
        ) {
            return record.resources().nix.require_guard_close();
        }
        if let Some(end) = ceiling {
            call_budget::CallBudget::bounded(end).check(runtime)?;
        }
        let actual = guard::consume(&mut record);
        // The worker purpose has no new wait or grace. Like source __exit__,
        // attempt owned local FD finalizers even after global stop expired.
        // Synchronous kernel filesystem I/O has no hard userspace time bound.
        let result = record
            .resources
            .as_mut()
            .expect("same retained resource")
            .nix
            .finish_close(actual.close());
        if result.is_err() {
            record.unknown = true;
            record.phase = Phase::CleanupRetained;
        }
        result
    }
}
impl WorkerRuntime {
    pub fn cleanup_laptop_nix_guard(&self, workflow: &LaptopWorkflow, end: Instant) -> Result<()> {
        self.laptop_workflows()
            .cleanup_nix_guard(self, workflow, Some(end))
    }
    pub fn cleanup_laptop_nix_guard_for_worker(
        &self,
        workflow: &LaptopWorkflow,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        self.laptop_workflows()
            .assert_worker_cleanup_connection(self, workflow, connection)?;
        self.laptop_workflows()
            .cleanup_nix_guard(self, workflow, None)
    }
    pub fn cleanup_created_laptop_nix_guard(
        &self,
        created: &CreatedLaptop,
        end: Instant,
    ) -> Result<()> {
        self.cleanup_laptop_nix_guard(&created.workflow, end)
    }
    pub fn cleanup_created_laptop_nix_guard_for_worker(
        &self,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        self.cleanup_laptop_nix_guard_for_worker(&created.workflow, connection)
    }
    /// Also handles the real stored constructor without a ViewerSession. No
    /// supplied PID, fake job or successful constructor token is introduced.
    pub fn close_created_laptop_viewer(&self, created: &CreatedLaptop, end: Instant) -> Result<()> {
        self.laptop_workflows().bound(self, &created.workflow)?;
        let mut record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(record.resources.is_some(), "WORKER_LAPTOP_REPLAYED")?;
        if !matches!(record.phase, Phase::Stopped | Phase::CleanupRetained) {
            record.phase = Phase::Cleaning;
        }
        match &record.viewer {
            Some(viewer) => viewer.close(self, end),
            None => Ok(()),
        }
    }
}
