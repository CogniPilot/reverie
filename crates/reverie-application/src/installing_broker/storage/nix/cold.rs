//! Fixed post-copy and pre-Office operations on the original retained Nix slot.
use super::*;
use reverie_host::{worker_launch::ObservedCreatePlan, worker_source_stop::StoppedLaptopRemoval};
impl NixStoragePreparation {
    fn check_current_entry(&self) -> Result<(), NixStorageError> {
        if let ReturnTo::Registered {
            registry, identity, ..
        } = &self.destination
        {
            registry.check_nix(identity, &self.workflow)?;
        }
        Ok(())
    }
    pub(in crate::installing_broker) fn recheck_after_copy(&self) -> Result<(), NixStorageError> {
        self.check_current_entry()?;
        self.destination
            .registry()
            .runtime
            .recheck_nix_launch_storage(&self.workflow)
            .map_err(Into::into)
    }
    pub(in crate::installing_broker) fn remove_old_laptop(
        &self,
        plan: &ObservedCreatePlan,
        removal: &mut StoppedLaptopRemoval,
    ) -> Result<(), NixStorageError> {
        self.check_current_entry()?;
        self.destination
            .registry()
            .runtime
            .remove_stopped_laptop_after_nix_for_worker(&self.workflow, plan, removal)?;
        Ok(())
    }
    pub(in crate::installing_broker) fn prepare_retained_temporary(
        &self,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> Result<(), NixStorageError> {
        self.check_current_entry()?;
        self.destination
            .registry()
            .runtime
            .prepare_retained_cold_tmp(&self.workflow, plan, end)
            .map_err(Into::into)
    }
}
