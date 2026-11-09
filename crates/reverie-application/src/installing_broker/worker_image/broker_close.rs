//! One actual unstarted installing owner, shared by inspection and apply. No
//! service/controller owner can be closed by a readonly inspection request.
use super::*;
use std::sync::{MutexGuard, atomic::Ordering};
pub(super) struct UnstartedImageBroker<'a> {
    broker: &'a InstallingBroker,
    controller: Option<MutexGuard<'a, Option<reverie_host::worker_pool::ActivatedController>>>,
    attempted: bool,
    errors: Vec<BrokerServiceError>,
}
impl<'a> UnstartedImageBroker<'a> {
    pub(super) fn new(broker: &'a InstallingBroker) -> Self {
        Self {
            broker,
            controller: None,
            attempted: false,
            errors: Vec::new(),
        }
    }
    pub(super) fn claim(&mut self) -> std::result::Result<(), OfflineImageSwitchError<'a>> {
        let controller =
            self.broker.controller.try_lock().map_err(|_| {
                OfflineImageSwitchError::refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE")
            })?;
        if controller.is_some() {
            return Err(OfflineImageSwitchError::refused(
                "WORKER_IMAGE_INSTALLED_CONTROLLER_REQUIRES_MAINTENANCE",
            ));
        }
        if self
            .broker
            .service_start_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(OfflineImageSwitchError::refused(
                "WORKER_IMAGE_REQUIRES_UNSTARTED_BROKER",
            ));
        }
        self.controller = Some(controller);
        Ok(())
    }
    pub(super) fn assert_controller(&self) -> std::result::Result<(), OfflineImageSwitchError<'a>> {
        if self.controller.as_deref().is_some_and(Option::is_none) {
            Ok(())
        } else {
            Err(OfflineImageSwitchError::refused(
                "WORKER_IMAGE_CONTROLLER_SLOT_CHANGED",
            ))
        }
    }
    pub(super) fn attempted(&self) -> bool {
        self.attempted
    }
    pub(super) fn close(
        &mut self,
        end: Instant,
    ) -> std::result::Result<(), OfflineImageSwitchError<'a>> {
        self.assert_controller()?;
        if self.attempted {
            return Err(OfflineImageSwitchError::refused(
                "WORKER_IMAGE_BROKER_CLOSE_ATTEMPTED",
            ));
        }
        self.attempted = true;
        let broker = self.broker;
        let end = end.min(broker.storage.runtime.request_stop());
        let io = broker.close_application_io(end, &mut self.errors);
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
            self.errors.push(BrokerServiceError::Runtime(error));
        }
        let closed = if self.errors.is_empty() && io.all_closed() {
            Ok(())
        } else {
            Err(OfflineImageSwitchError::broker(std::mem::take(
                &mut self.errors,
            )))
        };
        match (observer, closed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
            (Err(a), Err(b)) => Err(OfflineImageSwitchError::finalized(a, b)),
        }
    }
}
/// Known original installing-broker closure only; no service or image grant.
#[derive(Debug)]
pub struct ClosedOfflineImageInspection {
    _private: (),
}
pub struct OfflineImageInspectionFailure<'a> {
    owner: Option<Box<UnstartedImageBroker<'a>>>,
    cause: OfflineImageSwitchError<'a>,
}
impl OfflineImageInspectionFailure<'_> {
    pub fn cause(&self) -> &OfflineImageSwitchError<'_> {
        &self.cause
    }
}
impl std::fmt::Debug for OfflineImageInspectionFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("OfflineImageInspectionFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Display for OfflineImageInspectionFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for OfflineImageInspectionFailure<'_> {}
impl Drop for OfflineImageInspectionFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl InstallingBroker {
    pub fn close_offline_image_inspection(
        &self,
        end: Instant,
    ) -> std::result::Result<ClosedOfflineImageInspection, Box<OfflineImageInspectionFailure<'_>>>
    {
        let mut owner = Box::new(UnstartedImageBroker::new(self));
        let body = owner.claim().and_then(|()| owner.close(end));
        match body {
            Ok(()) => Ok(ClosedOfflineImageInspection { _private: () }),
            Err(cause) => Err(Box::new(OfflineImageInspectionFailure {
                owner: Some(owner),
                cause,
            })),
        }
    }
}
