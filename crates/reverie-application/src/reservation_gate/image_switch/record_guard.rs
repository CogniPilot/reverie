use super::*;
impl Inner {
    pub(in crate::reservation_gate) fn assert_no_failed_image(&self) -> Result<()> {
        let failed = self
            .failed_image
            .lock()
            .map_err(|_| GateError::Refused("WORKER_IMAGE_REQUIRES_RECONCILIATION"))?;
        need(failed.is_none(), "WORKER_IMAGE_REQUIRES_RECONCILIATION")
    }
    pub(in crate::reservation_gate) fn image_or_gpu_pending_current(
        &self,
        active: &Arc<Active>,
    ) -> Result<()> {
        let image = active
            .image_transition
            .lock()
            .map_err(|_| GateError::Refused("WORKER_IMAGE_TRANSITION_UNAVAILABLE"))?
            .clone();
        match image {
            Some(record) => record
                .upgrade()
                .ok_or(GateError::Refused("WORKER_IMAGE_TRANSITION_RETAINED"))?
                .assert_pending(),
            None => self.gpu_pending_current(active),
        }
    }
    pub(in crate::reservation_gate) fn image_rows_current(
        &self,
        active: &Arc<Active>,
        rows: &ObservedInventory,
    ) -> Result<()> {
        let selected = active
            .image_transition
            .lock()
            .map_err(|_| GateError::Refused("WORKER_IMAGE_TRANSITION_UNAVAILABLE"))?
            .clone();
        if let Some(record) = selected {
            let record = record
                .upgrade()
                .ok_or(GateError::Refused("WORKER_IMAGE_TRANSITION_RETAINED"))?;
            need(record.rows.equivalent(rows), "WORKER_IMAGE_NATIVE_CHANGED")?;
        }
        Ok(())
    }
}
