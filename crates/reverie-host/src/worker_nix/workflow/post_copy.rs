//! Original post-copy storage/intent/writer observations over the SAME resources.
//! Current configuration/effective equality and budget remain actual App phases.
use super::*;
use reverie_contracts::resource_config::ResourceIdentitySettings;
impl WorkerRuntime {
    pub fn recheck_nix_launch_storage(&self, workflow: &NixWorkflow) -> Result<()> {
        let workflows = self.nix_workflows();
        workflows.bound(self, workflow)?;
        let record = workflow.record.try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        need(record.phase == Phase::Known && !record.turn && matches!(&record.outcome, Some(Ok(_))), NixFault::Retained)?;
        let storage = &record.resources().storage;
        let selected = self.resolve_storage(&record.prepared, &workflow.session)?;
        need(selected.paths() == storage.paths(), NixFault::StoreBinding)?;
        let settings = ResourceIdentitySettings::capture_worker_config(&record.prepared)
            .map_err(crate::worker_storage::StorageOwnerError::Settings)?;
        let config = StorageIdentityConfig::capture_worker_settings(&settings);
        need(storage_identity::storage_start_allowed(&config, storage.paths())?, NixFault::StoreBinding)?;
        if storage.paths().employee().is_some() {
            self.check_storage_writers(storage, None)?;
        }
        // The original phase observations above keep their error precedence.
        // This additional resource-custody check supplies no effect authority.
        record.resources().guard.assert_current()?;
        storage.check_resource_current()?;
        Ok(())
    }
}
