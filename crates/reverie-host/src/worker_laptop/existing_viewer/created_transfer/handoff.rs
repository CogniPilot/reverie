//! Read-side lineage from the actual consuming Started transfer. It grants no
//! stop or release; consumers must still own the current storage allocation.
use super::*;

pub struct StartedStorageHandoff {
    original: LaptopWorkflow,
    storage: Arc<()>,
}
impl StartedStorageHandoff {
    pub(super) fn new(created: &CreatedLaptop, storage: &LaunchStorage) -> Self {
        Self {
            original: created.workflow.clone(),
            storage: storage.owner_identity().clone(),
        }
    }
    pub fn assert_created(&self, runtime: &WorkerRuntime, created: &CreatedLaptop) -> Result<()> {
        need(
            Arc::ptr_eq(&self.original.origin, runtime.installed_engine())
                && self.original.same_workflow(&created.workflow),
            "WORKER_STARTED_HANDOFF_ORIGIN",
        )
    }
    pub fn assert_storage(&self, runtime: &WorkerRuntime, storage: &LaunchStorage) -> Result<()> {
        need(
            Arc::ptr_eq(&self.original.origin, runtime.installed_engine())
                && Arc::ptr_eq(&self.storage, storage.owner_identity()),
            "WORKER_STARTED_HANDOFF_STORAGE",
        )
    }
    /// This validates actual retained custody without observing a receipt or
    /// implying healthy completion. Recorded native/finalizer errors survive.
    pub fn pending_existing(&self, runtime: &WorkerRuntime, viewer: &ExistingViewer) -> Result<()> {
        need(
            Arc::ptr_eq(&self.original.origin, &viewer.reference.origin),
            "WORKER_STARTED_HANDOFF_ORIGIN",
        )?;
        let record = viewer
            .reference
            .record
            .try_lock()
            .map_err(|error| ReadContention::CreatedReceipt.error(error))?;
        let inputs = record
            .inputs
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_EXISTING_VIEWER_CONSUMED"))?;
        self.assert_storage(runtime, &inputs.storage)?;
        if let Some(error) = record.failure.as_ref().or(record.finalization.failure()) {
            return Err(LaptopError::Recorded(error.clone()));
        }
        Ok(())
    }
}
