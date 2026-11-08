use super::*;
impl<'a> Owner<'a> {
    pub(super) fn finish(
        &mut self,
    ) -> std::result::Result<OfflineImageSwitchClosed, OfflineImageSwitchError<'a>> {
        self.broker_close.close(self.end)?;
        self.closed_locks = Some(
            self.locks
                .take()
                .expect("same deployment locks")
                .close()
                .map_err(OfflineImageSwitchError::maintenance)?,
        );
        let origin = self.service.as_ref().expect("same service fence").origin();
        self.closed_service = Some(
            self.service
                .take()
                .expect("same service fence")
                .close()
                .map_err(OfflineImageSwitchError::service)?,
        );
        let closed = self.closed_gate.as_mut().expect("known R boundary");
        closed
            .assert_current()
            .map_err(OfflineImageSwitchError::gate)?;
        self.closed_locks
            .as_ref()
            .expect("known lock closure")
            .assert_current()
            .map_err(OfflineImageSwitchError::files)?;
        self.broker_close.assert_controller()?;
        require(
            self.closed_service
                .as_ref()
                .expect("known service closure")
                .belongs_to(&origin),
            "WORKER_IMAGE_SERVICE_ORIGIN_CHANGED",
        )?;
        let configuration = closed.configuration_digest().clone();
        let old_image = self.old_image.clone();
        let new_image = self.qualification.image.clone();
        let preview = self.digest.clone();
        // Deployment/service fences remain while R pending closes. Service's
        // actual outer release is LAST; its failure owns the original fence.
        closed.release().map_err(OfflineImageSwitchError::gate)?;
        let service = self
            .closed_service
            .take()
            .expect("same closed outer fence")
            .release()
            .map_err(OfflineImageSwitchError::service)?;
        Ok(OfflineImageSwitchClosed {
            service,
            old_image,
            new_image,
            preview,
            configuration,
        })
    }
    pub(super) fn cleanup(&mut self, errors: &mut Vec<OfflineImageSwitchError<'a>>) {
        if let Some(gate) = &mut self.gate
            && let Err(error) = gate.close_components()
        {
            errors.push(OfflineImageSwitchError::gate(error));
        }
        if let Err(error) = self.qualification.close(self.end) {
            errors.push(OfflineImageSwitchError::qualification(error));
        }
        if !self.broker_close.attempted()
            && let Err(error) = self.broker_close.close(self.end)
        {
            errors.push(error);
        }
        if let Some(locks) = self.locks.take() {
            match locks.close() {
                Ok(closed) => self.closed_locks = Some(closed),
                Err(error) => errors.push(OfflineImageSwitchError::maintenance(error)),
            }
        }
        if let Some(service) = self.service.take() {
            match service.close() {
                Ok(closed) => self.closed_service = Some(closed),
                Err(error) => errors.push(OfflineImageSwitchError::service(error)),
            }
        }
    }
}
