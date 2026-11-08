use super::*;
impl<'a> Owner<'a> {
    pub(super) fn finish(
        &mut self,
    ) -> std::result::Result<OfflineImageSwitchClosed, OfflineImageSwitchError<'a>> {
        self.close_broker()?;
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
        require(
            self.controller.as_deref().is_some_and(Option::is_none),
            "WORKER_IMAGE_CONTROLLER_SLOT_CHANGED",
        )?;
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
    fn close_broker(&mut self) -> std::result::Result<(), OfflineImageSwitchError<'a>> {
        require(
            !self.broker_close_attempted,
            "WORKER_IMAGE_BROKER_CLOSE_ATTEMPTED",
        )?;
        self.broker_close_attempted = true;
        let broker = self.broker();
        let end = self.end.min(broker.storage.runtime.request_stop());
        let io = broker.close_application_io(end, &mut self.broker_close_errors);
        let observer = broker
            .gate
            .as_ref()
            .map_or(Ok(()), |gate| gate.settle_owned(end))
            .map_err(OfflineImageSwitchError::gate);
        let native = if io.all_closed() {
            broker.storage.runtime.close(end)
        } else {
            broker.storage.runtime.settle_owned(end)
        };
        if let Err(error) = native {
            self.broker_close_errors
                .push(BrokerServiceError::Runtime(error));
        }
        let closed = if self.broker_close_errors.is_empty() && io.all_closed() {
            Ok(())
        } else {
            Err(OfflineImageSwitchError::broker(std::mem::take(
                &mut self.broker_close_errors,
            )))
        };
        match (observer, closed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
            (Err(a), Err(b)) => Err(OfflineImageSwitchError::finalized(a, b)),
        }
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
        if !self.broker_close_attempted
            && let Err(error) = self.close_broker()
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
