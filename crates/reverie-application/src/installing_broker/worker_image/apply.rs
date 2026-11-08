//! The bootstrap-only image transition. Real service, native image, deployment
//! locks and R owners remain on this original stack throughout every phase.
use super::*;
use crate::reservation_gate::{ImageGateClosed, ImageGateFailure, ImageGateTransition};
use reverie_core::operations::{JournalDigest, JournalId};
use reverie_host::{
    worker_image::{ClosedImageMaintenance, ImageMaintenanceFailure, ImageMaintenanceLocks},
    worker_service::{
        ClosedImageServiceMaintenance, ClosedStoppedWorkerService, ImageServiceMaintenance,
        StoppedServiceFailure, WorkerServiceError,
    },
};
use std::path::Path;
mod error;
mod finish;
pub use error::{OfflineImageSwitchError, OfflineImageSwitchFailure};
struct Owner<'a> {
    qualification: Box<Qualification<'a>>,
    service: Option<ImageServiceMaintenance>,
    closed_service: Option<ClosedImageServiceMaintenance>,
    locks: Option<ImageMaintenanceLocks>,
    closed_locks: Option<ClosedImageMaintenance>,
    gate: Option<ImageGateTransition<'a>>,
    closed_gate: Option<ImageGateClosed>,
    broker_close: super::broker_close::UnstartedImageBroker<'a>,
    end: Instant,
    old_image: WorkerImageId,
    digest: JournalDigest,
}
#[derive(Debug)]
pub struct OfflineImageSwitchClosed {
    service: ClosedStoppedWorkerService,
    old_image: WorkerImageId,
    new_image: WorkerImageId,
    preview: JournalDigest,
    configuration: JournalDigest,
}
impl OfflineImageSwitchClosed {
    pub fn old_image(&self) -> &WorkerImageId {
        &self.old_image
    }
    pub fn new_image(&self) -> &WorkerImageId {
        &self.new_image
    }
    pub fn preview_digest(&self) -> &JournalDigest {
        &self.preview
    }
    pub fn configuration_digest(&self) -> &JournalDigest {
        &self.configuration
    }
    pub fn source(&self) -> &Path {
        self.service.source()
    }
    pub fn service_generation(&self) -> &Path {
        self.service.generation()
    }
}
impl<'a> PreparedOfflineImageSwitch<'a> {
    pub fn apply(
        mut self,
        service: ImageServiceMaintenance,
        expected_preview: &JournalDigest,
        operation: JournalId,
    ) -> std::result::Result<OfflineImageSwitchClosed, Box<OfflineImageSwitchFailure<'a>>> {
        let qualification = self.owner.take().expect("same prepared native image");
        let end = service.end().min(qualification.end);
        let digest = qualification
            .preview
            .as_ref()
            .expect("actual frozen preview")
            .digest()
            .clone();
        let old_image = WorkerImageId::parse(qualification.before.envelope().base().image())
            .expect("validated exact source image");
        let broker_close = super::broker_close::UnstartedImageBroker::new(qualification.broker);
        let mut owner = Box::new(Owner {
            qualification,
            service: Some(service),
            closed_service: None,
            locks: None,
            closed_locks: None,
            gate: None,
            closed_gate: None,
            broker_close,
            end,
            old_image,
            digest,
        });
        let body = owner.run(expected_preview, operation);
        match body {
            Ok(value) => Ok(value),
            Err(cause) => {
                let mut failure = Box::new(OfflineImageSwitchFailure {
                    owner: Some(owner),
                    cause,
                    cleanup_attempted: false,
                    cleanup: Vec::new(),
                });
                let _ = failure.close_components();
                Err(failure)
            }
        }
    }
}
impl<'a> Owner<'a> {
    fn broker(&self) -> &'a InstallingBroker {
        self.qualification.broker
    }
    fn run(
        &mut self,
        expected: &JournalDigest,
        operation: JournalId,
    ) -> std::result::Result<OfflineImageSwitchClosed, OfflineImageSwitchError<'a>> {
        self.enter(expected, operation)?;
        self.gate
            .as_mut()
            .expect("actual R transition")
            .prepare_publication(self.end)
            .map_err(OfflineImageSwitchError::gate)?;
        // Native census may have waited. Revalidate the SAME actual service
        // and locks now, then pass them into the Host final-rename boundary.
        self.service
            .as_mut()
            .expect("original service fence")
            .revalidate()
            .map_err(OfflineImageSwitchError::service_component)?;
        self.locks
            .as_mut()
            .expect("original deployment locks")
            .assert_held_current()
            .map_err(OfflineImageSwitchError::files)?;
        self.gate
            .as_mut()
            .expect("actual R transition")
            .publish(
                self.locks.as_mut().expect("same deployment locks"),
                self.service.as_ref().expect("same service fence"),
            )
            .map_err(OfflineImageSwitchError::gate)?;
        // Full native image recheck precedes the final R boundary. After that
        // boundary, only original component finalizers/metadata stamps run.
        self.qualification
            .observe(self.end)
            .map_err(OfflineImageSwitchError::qualification)?;
        self.qualification
            .close(self.end)
            .map_err(OfflineImageSwitchError::qualification)?;
        self.closed_gate = Some(
            self.gate
                .take()
                .expect("same R transition")
                .finish()
                .map_err(OfflineImageSwitchError::gate_owner)?,
        );
        self.finish()
    }
    fn enter(
        &mut self,
        expected: &JournalDigest,
        operation: JournalId,
    ) -> std::result::Result<(), OfflineImageSwitchError<'a>> {
        require(&self.digest == expected, "WORKER_IMAGE_PREVIEW_CHANGED")?;
        let source = self
            .qualification
            .before
            .source_path()
            .ok_or_else(|| {
                OfflineImageSwitchError::refused("WORKER_IMAGE_REGISTERED_SOURCE_REQUIRED")
            })?
            .to_owned();
        require(
            self.service
                .as_ref()
                .expect("actual service fence")
                .source()
                == source,
            "WORKER_IMAGE_SERVICE_SOURCE_CHANGED",
        )?;
        require(
            !reverie_contracts::gpu_access::has_resource_actor(
                self.qualification.before.configuration(),
            ),
            "WORKER_IMAGE_EXTERNAL_CONSUMER_MAINTENANCE_REQUIRED",
        )?;
        self.qualification
            .observe(self.end)
            .map_err(OfflineImageSwitchError::qualification)?;
        let broker = self.broker();
        self.broker_close.claim()?;
        self.locks = Some(
            ImageMaintenanceLocks::capture(
                &source,
                self.qualification.before.configuration(),
                self.end,
            )
            .map_err(OfflineImageSwitchError::maintenance)?,
        );
        require(
            self.locks.as_ref().expect("captured locks").source() == source
                && self.locks.as_ref().expect("captured locks").end() == self.end,
            "WORKER_IMAGE_MAINTENANCE_SOURCE_CHANGED",
        )?;
        let gate = broker
            .resource_reservations()
            .map_err(OfflineImageSwitchError::gate)?
            .ok_or_else(|| OfflineImageSwitchError::refused("WORKER_IMAGE_EXISTING_R_REQUIRED"))?;
        self.gate = Some(
            gate.enter_image_switch(
                self.qualification
                    .preview_files
                    .take()
                    .expect("same private file owner"),
                self.qualification
                    .preview
                    .take()
                    .expect("same immutable preview"),
                operation,
                self.end,
            )
            .map_err(OfflineImageSwitchError::gate_owner)?,
        );
        Ok(())
    }
}
fn require<'a>(
    value: bool,
    code: &'static str,
) -> std::result::Result<(), OfflineImageSwitchError<'a>> {
    if value {
        Ok(())
    } else {
        Err(OfflineImageSwitchError::refused(code))
    }
}
