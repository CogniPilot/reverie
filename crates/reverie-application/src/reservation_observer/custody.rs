use super::*;
use reverie_host::{
    reservation_control::{CurrentImageBinding, PolicyBinding},
    reservation_kernel::CustodyPaths,
};
/// Only actual service-owned target producers belong here. This is not a wire
/// selector or an inventory/source constructor, and grants no effect authority.
pub(super) enum SelectedTargets<'a> {
    Control,
    CurrentImage(&'a CurrentImageBinding),
    PreparedPolicy(&'a PolicyBinding),
    LoadedPolicy(&'a crate::worker_validation::ValidatedWorkerSnapshot),
    GpuSource(&'a crate::worker_validation::ValidatedWorkerSnapshot),
}
impl ObservationContext {
    pub(crate) fn custody_gpu_source(
        &self,
        snapshot: &crate::worker_validation::ValidatedWorkerSnapshot,
        supplied: Option<Instant>,
    ) -> Result<ObservedInventory> {
        self.custody_selected(SelectedTargets::GpuSource(snapshot), supplied)
    }
    pub(crate) fn custody_loaded_policy(
        &self,
        snapshot: &crate::worker_validation::ValidatedWorkerSnapshot,
        supplied: Option<Instant>,
    ) -> Result<ObservedInventory> {
        self.custody_selected(SelectedTargets::LoadedPolicy(snapshot), supplied)
    }
    pub fn custody_policy(
        &self,
        policy: &PolicyBinding,
        supplied: Option<Instant>,
    ) -> Result<ObservedInventory> {
        self.custody_selected(SelectedTargets::PreparedPolicy(policy), supplied)
    }
    pub fn custody_current_image(
        &self,
        image: &CurrentImageBinding,
        supplied: Option<Instant>,
    ) -> Result<ObservedInventory> {
        self.custody_selected(SelectedTargets::CurrentImage(image), supplied)
    }
    pub(super) fn custody_selected(
        &self,
        selected: SelectedTargets<'_>,
        supplied: Option<Instant>,
    ) -> Result<ObservedInventory> {
        let end = self.deadline(supplied)?;
        let paths = match selected {
            SelectedTargets::Control => CustodyPaths::control(&self.config)?,
            SelectedTargets::CurrentImage(image) => {
                CustodyPaths::current_image(&self.config, image)?
            }
            SelectedTargets::PreparedPolicy(policy) => CustodyPaths::prepared_policy(policy)?,
            SelectedTargets::LoadedPolicy(snapshot) => {
                use std::os::unix::ffi::OsStrExt;
                let path = snapshot.source_path().ok_or(ObserverError::Refused(
                    "RESOURCE_PREPARATION_CONFIG_FILE_REQUIRED",
                ))?;
                let binding = reverie_core::posix_path::PosixPath::try_new(
                    &reverie_core::posix_text::decode(path.as_os_str().as_bytes()),
                )
                .expect("native path codepoints");
                CustodyPaths::declared(binding.parent(), binding)?
            }
            SelectedTargets::GpuSource(snapshot) => {
                use std::os::unix::ffi::OsStrExt;
                let path = snapshot
                    .source_path()
                    .ok_or(ObserverError::Refused("GPU_OWNER_CONTROL_UNAVAILABLE"))?;
                let binding = reverie_core::posix_path::PosixPath::try_new(
                    &reverie_core::posix_text::decode(path.as_os_str().as_bytes()),
                )
                .expect("native source codepoints");
                CustodyPaths::declared(self.config.control_paths()?.root().clone(), binding)?
            }
        };
        let source = &self.observer.source;
        let table = source.mount_table(end)?;
        let before = self.inventory_at(end)?;
        source.custody_scan(&self.config, &paths, &before.rows, &table, end)?;
        need(
            source.mount_table(end)? == table,
            "RESERVATION_MOUNT_TABLE_CHANGED",
        )?;
        let after = self.inventory_at(end)?;
        need(
            before.rows.mount_shape()? == after.rows.mount_shape()?,
            "RESERVATION_MOUNT_INVENTORY_CHANGED",
        )?;
        self.check(end)?;
        Ok(before)
    }
}
