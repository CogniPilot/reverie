//! Own the actual R/lifecycle/files before any fallible entry or publication.
use super::*;
use reverie_contracts::worker_image_switch::{ImagePinTransition, WorkerImageId};
use reverie_core::operations::JournalDigest;
use reverie_host::worker_image::{ImageControlFiles, ImageProtectedStores, ImageTerminalSnapshot};
pub(crate) struct ImageGateTransition<'a> {
    owner: Option<Box<Owner<'a>>>,
}
struct Owner<'a> {
    gate: &'a ReservationGate,
    files: Option<ImageControlFiles>,
    preview: ImageSwitchPreview,
    admission: Option<super::super::admission::Admission>,
    lifecycle: Option<crate::installing_broker::LaptopLifecycle<'a>>,
    record: Option<Arc<ImageTransitionRecord>>,
    protected: Option<ImageProtectedStores>,
    cleanup: Option<Arc<GateError>>,
}
pub(crate) struct ImageGateFailure<'a> {
    owner: Option<Box<Owner<'a>>>,
    cause: GateError,
    cleanup: Option<Arc<GateError>>,
}
pub(crate) struct ImageGateClosed {
    record: Arc<ImageTransitionRecord>,
    terminal: ImageTerminalSnapshot,
}
impl ReservationGate {
    pub(crate) fn enter_image_switch<'a>(
        &'a self,
        files: ImageControlFiles,
        preview: ImageSwitchPreview,
        operation: JournalId,
        end: Instant,
    ) -> std::result::Result<ImageGateTransition<'a>, Box<ImageGateFailure<'a>>> {
        let mut owner = Box::new(Owner {
            gate: self,
            files: Some(files),
            preview,
            admission: None,
            lifecycle: None,
            record: None,
            protected: None,
            cleanup: None,
        });
        if let Err(cause) = owner.enter(operation, end) {
            return Err(Box::new(ImageGateFailure {
                owner: Some(owner),
                cause,
                cleanup: None,
            }));
        }
        Ok(ImageGateTransition { owner: Some(owner) })
    }
}
impl<'a> Owner<'a> {
    fn close_components(&mut self) -> Result<()> {
        if let Some(error) = &self.cleanup {
            return Err(GateError::ImageTransition(error.clone()));
        }
        let closed = self
            .admission
            .take()
            .map_or(Ok(()), |admission| admission.abort());
        self.lifecycle = None;
        if let Err(error) = closed {
            let error = Arc::new(error);
            self.cleanup = Some(error.clone());
            return Err(GateError::ImageTransition(error));
        }
        Ok(())
    }
    fn enter(&mut self, operation: JournalId, end: Instant) -> Result<()> {
        self.admission = Some(self.gate.inner.admit(AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        })?);
        let gate = self.gate;
        self.lifecycle = Some(gate.inner.installed.lifecycle()?);
        let rows = gate.inner.assert_image_preview_held(
            &self.preview,
            self.files.as_mut().expect("retained original files"),
        )?;
        let old = WorkerImageId::parse(self.preview.before.envelope().base().image())
            .map_err(|_| GateError::Refused("WORKER_IMAGE_EXACT_PIN_REQUIRED"))?;
        let intent = ImagePinTransition::prepare(
            &self.preview.raw,
            &old,
            self.preview.image.clone(),
            operation,
            self.preview.digest().clone(),
        )
        .map_err(|_| GateError::Refused("WORKER_IMAGE_PREVIEW_CHANGED"))?;
        let record = gate.inner.begin_image_transition(
            self.files.take().expect("same files transfer"),
            rows,
            Arc::new(intent),
        )?;
        self.record = Some(record.clone());
        self.protected = Some(record.protected_stores()?);
        Ok(())
    }
    fn prepare_publication(&mut self, end: Instant) -> Result<()> {
        let record = self.record.as_ref().expect("actual entered record");
        let body = (|| {
            record.publish_pending(end)?;
            let rows = self.gate.inner.image_idle()?;
            need(record.rows.equivalent(&rows), "WORKER_IMAGE_NATIVE_CHANGED")
        })();
        record.keep(body)
    }
    fn publish(
        &mut self,
        locks: &mut reverie_host::worker_image::ImageMaintenanceLocks,
        service: &reverie_host::worker_service::ImageServiceMaintenance,
    ) -> Result<()> {
        let record = self.record.as_ref().expect("actual entered record");
        let body = (|| {
            record.publish_maintained_configuration(locks, service)?;
            self.gate
                .inner
                .publish_image_record(record, self.lifecycle.as_ref().expect("actual lifecycle"))
        })();
        record.keep(body)
    }
}
impl ImageGateFailure<'_> {
    pub(crate) fn cause(&self) -> &GateError {
        &self.cause
    }
    pub(crate) fn close_components(&mut self) -> Result<()> {
        if let Some(error) = &self.cleanup {
            return Err(GateError::ImageTransition(error.clone()));
        }
        let Some(owner) = &mut self.owner else {
            return Ok(());
        };
        owner.close_components()
    }
}
impl ImageGateTransition<'_> {
    pub(crate) fn prepare_publication(&mut self, end: Instant) -> Result<()> {
        self.owner
            .as_mut()
            .expect("actual transition owner")
            .prepare_publication(end)
    }
    pub(crate) fn publish(
        &mut self,
        locks: &mut reverie_host::worker_image::ImageMaintenanceLocks,
        service: &reverie_host::worker_service::ImageServiceMaintenance,
    ) -> Result<()> {
        self.owner
            .as_mut()
            .expect("actual transition owner")
            .publish(locks, service)
    }
    pub(crate) fn close_components(&mut self) -> Result<()> {
        self.owner
            .as_mut()
            .expect("same actual transition")
            .close_components()
    }
}
impl<'a> ImageGateTransition<'a> {
    pub(crate) fn finish(
        mut self,
    ) -> std::result::Result<ImageGateClosed, Box<ImageGateFailure<'a>>> {
        let mut owner = self.owner.take().expect("same transition owner");
        let record = owner
            .record
            .as_ref()
            .expect("actual entered record")
            .clone();
        let result = (|| {
            let rows = owner.gate.inner.image_idle()?;
            need(record.rows.equivalent(&rows), "WORKER_IMAGE_NATIVE_CHANGED")?;
            owner
                .admission
                .take()
                .expect("same actual admission")
                .finish_image(&record)?;
            owner.lifecycle = None;
            record.terminal(owner.protected.as_ref().expect("same protected stores"))
        })();
        match result {
            Ok(terminal) => Ok(ImageGateClosed { record, terminal }),
            Err(cause) => {
                let error = Arc::new(cause);
                let cleanup = owner.admission.is_none().then(|| error.clone());
                Err(Box::new(ImageGateFailure {
                    owner: Some(owner),
                    cause: GateError::ImageTransition(error),
                    cleanup,
                }))
            }
        }
    }
}
impl ImageGateClosed {
    pub(crate) fn assert_current(&self) -> Result<()> {
        Ok(self.terminal.assert_current()?)
    }
    pub(crate) fn configuration_digest(&self) -> &JournalDigest {
        self.record.intent.after_digest()
    }
    pub(crate) fn release(&mut self) -> Result<()> {
        self.record.release(&self.terminal)
    }
}
impl Drop for ImageGateTransition<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl Drop for ImageGateFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
