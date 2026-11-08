//! Image-only offline maintenance. Ordinary, GPU and pool admissions retain
//! their own purposes; an image selection is not effect or pending authority.
use super::*;
use reverie_contracts::reservation_engine::StoppedFlag;
impl Inner {
    /// Read under the original actual R admission. The public offline owner
    /// must separately retain its registered-service interlock and image proof.
    pub(super) fn image_idle(&self) -> Result<ObservedInventory> {
        self.held(None)?;
        self.require_host_job_idle()?;
        need(
            self.active_operations(&self.document()?)?.is_empty(),
            "WORKER_IMAGE_RETAINED_WORK",
        )?;
        let rows = self.guard(None)?;
        let context = self.native_context()?;
        let deployment = self.config()?.deployment()?;
        for row in rows.rows() {
            if !row.data().image_maintenance_member(&deployment)? {
                continue;
            }
            need(
                !row.data().running()? && row.data().pid()?.is_zero(),
                "WORKER_IMAGE_LAPTOPS_MUST_BE_STOPPED",
            )?;
            let state = context.stopped_state(&row, None)?;
            need(
                !state.flag(StoppedFlag::Running)
                    && !state.flag(StoppedFlag::Paused)
                    && !state.flag(StoppedFlag::Restarting)
                    && ["created", "exited", "dead"]
                        .iter()
                        .any(|status| state.status_is(status)),
                "WORKER_IMAGE_LAPTOPS_MUST_BE_STOPPED",
            )?;
        }
        let after = self.guard(None)?;
        need(rows.equivalent(&after), "WORKER_IMAGE_NATIVE_CHANGED")?;
        Ok(rows)
    }
}
#[cfg(test)]
mod tests;
