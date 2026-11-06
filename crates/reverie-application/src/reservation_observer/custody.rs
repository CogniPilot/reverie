use super::*;
use reverie_host::{reservation_control::CurrentImageBinding, reservation_kernel::CustodyPaths};
/// Only actual service-owned target producers belong here. This is not a wire
/// selector or an inventory/source constructor, and grants no effect authority.
pub(super) enum SelectedTargets<'a> {
    Control,
    CurrentImage(&'a CurrentImageBinding),
}
impl ObservationContext {
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
