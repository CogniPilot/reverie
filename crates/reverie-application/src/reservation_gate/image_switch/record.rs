use super::*;
use reverie_contracts::worker_image_switch::ImagePinTransition;
use reverie_host::worker_image::{
    ImageControlFiles, ImageFileStamp, ImagePendingFile, ImageProtectedStores, ImagePublication,
    ImageTerminalSnapshot,
};
pub(in crate::reservation_gate) struct ImageTransitionRecord {
    pub(in crate::reservation_gate) active: Arc<Active>,
    pub(super) gate: Weak<Inner>,
    pub(super) rows: Arc<ObservedInventory>,
    pub(super) before: Arc<ValidatedWorkerSnapshot>,
    pub(super) intent: Arc<ImagePinTransition>,
    pub(super) files: Mutex<Files>,
    pub(super) failure: Mutex<Option<Arc<GateError>>>,
}
pub(super) struct Files {
    files: ImageControlFiles,
    stamp: Option<ImageFileStamp>,
    pending: Option<ImagePendingFile>,
    publication: Option<ImagePublication>,
    closed: bool,
}
impl Inner {
    pub(super) fn begin_image_transition(
        self: &Arc<Self>,
        files: ImageControlFiles,
        rows: Arc<ObservedInventory>,
        intent: Arc<ImagePinTransition>,
    ) -> Result<Arc<ImageTransitionRecord>> {
        let active = self.held(None)?;
        self.native_context()?.assert_inventory_origin(&rows)?;
        let before = self.installed.snapshot()?;
        need(
            reverie_contracts::worker_config::equivalent(before.configuration(), intent.before()),
            "WORKER_IMAGE_CONFIGURATION_CHANGED",
        )?;
        need(
            active
                .gpu_transition
                .lock()
                .map_err(|_| GateError::Refused("WORKER_IMAGE_TRANSITION_UNAVAILABLE"))?
                .is_none(),
            "WORKER_IMAGE_OTHER_TRANSITION",
        )?;
        let mut selected = active
            .image_transition
            .lock()
            .map_err(|_| GateError::Refused("WORKER_IMAGE_TRANSITION_UNAVAILABLE"))?;
        need(selected.is_none(), "WORKER_IMAGE_ATTEMPT_USED")?;
        let record = Arc::new(ImageTransitionRecord {
            active: active.clone(),
            gate: Arc::downgrade(self),
            rows,
            before,
            intent,
            files: Mutex::new(Files {
                files,
                stamp: None,
                pending: None,
                publication: None,
                closed: false,
            }),
            failure: Mutex::new(None),
        });
        *selected = Some(Arc::downgrade(&record));
        drop(selected);
        Ok(record)
    }
    pub(super) fn publish_image_record(
        &self,
        record: &Arc<ImageTransitionRecord>,
        lifecycle: &crate::installing_broker::LaptopLifecycle<'_>,
    ) -> Result<()> {
        record.current()?;
        let body = (|| {
            need(
                Arc::ptr_eq(&self.installed.snapshot()?, &record.before),
                "WORKER_IMAGE_CONFIGURATION_CHANGED",
            )?;
            record.assert_pending()?;
            let proof = crate::installing_broker::LoadedLaunchImage::load(
                self.source_path.as_deref().ok_or(GateError::Refused(
                    "WORKER_IMAGE_REGISTERED_SOURCE_REQUIRED",
                ))?,
            )?;
            proof.require_configuration(record.intent.candidate())?;
            let mut context = record
                .active
                .context
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
            self.installed
                .publish_launch_image(proof, lifecycle, Some(&mut context))?;
            Ok(())
        })();
        record.keep(body)
    }
}
impl ImageTransitionRecord {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Files>> {
        self.files
            .lock()
            .map_err(|_| GateError::Refused("WORKER_IMAGE_TRANSITION_UNAVAILABLE"))
    }
    fn healthy(&self) -> Result<()> {
        if let Some(error) = self
            .failure
            .lock()
            .map_err(|_| GateError::Refused("WORKER_IMAGE_TRANSITION_UNAVAILABLE"))?
            .as_ref()
        {
            return Err(GateError::ImageTransition(error.clone()));
        }
        Ok(())
    }
    pub(super) fn current(&self) -> Result<()> {
        self.healthy()?;
        let gate = self
            .gate
            .upgrade()
            .ok_or(GateError::Refused("WORKER_IMAGE_ADMISSION_CHANGED"))?;
        need(
            Arc::ptr_eq(&gate.held(None)?, &self.active),
            "WORKER_IMAGE_ADMISSION_CHANGED",
        )
    }
    pub(super) fn keep<T>(self: &Arc<Self>, result: Result<T>) -> Result<T> {
        let Err(cause) = result else {
            return result;
        };
        let mut first = self.failure.lock().unwrap_or_else(|e| e.into_inner());
        let saved = first.get_or_insert_with(|| Arc::new(cause)).clone();
        drop(first);
        if let Some(gate) = self.gate.upgrade() {
            let mut failed = gate.failed_image.lock().unwrap_or_else(|e| e.into_inner());
            if failed.is_none() {
                *failed = Some(self.clone());
            }
        }
        Err(GateError::ImageTransition(saved))
    }
    pub(super) fn protected_stores(self: &Arc<Self>) -> Result<ImageProtectedStores> {
        self.current()?;
        let result = (|| {
            let mut state = self.lock()?;
            let read = state.files.read_configuration()?;
            need(
                read.bytes() == self.intent.before_bytes(),
                "WORKER_IMAGE_SOURCE_CHANGED",
            )?;
            state.stamp = Some(read.stamp().clone());
            Ok(state.files.protected_stores()?)
        })();
        self.keep(result)
    }
    pub(super) fn publish_pending(self: &Arc<Self>, end: Instant) -> Result<()> {
        self.current()?;
        let result = (|| {
            let mut state = self.lock()?;
            need(
                state.stamp.is_some() && state.pending.is_none(),
                "WORKER_IMAGE_PUBLICATION_PHASE",
            )?;
            let pending = state.files.publish_pending(self.intent.clone(), end)?;
            state.pending = Some(pending);
            Ok(())
        })();
        self.keep(result)
    }
    pub(super) fn assert_pending(self: &Arc<Self>) -> Result<()> {
        self.current()?;
        let result = (|| {
            let mut state = self.lock()?;
            let Files { files, pending, .. } = &mut *state;
            let pending = pending
                .as_ref()
                .ok_or(GateError::Refused("WORKER_IMAGE_PENDING_CHANGED"))?;
            Ok(files.assert_pending_current(pending)?)
        })();
        self.keep(result)
    }
    pub(super) fn publish_maintained_configuration(
        self: &Arc<Self>,
        locks: &mut reverie_host::worker_image::ImageMaintenanceLocks,
        service: &reverie_host::worker_service::ImageServiceMaintenance,
    ) -> Result<()> {
        self.current()?;
        let result = (|| {
            let mut state = self.lock()?;
            let Files {
                files,
                stamp,
                pending,
                publication,
                ..
            } = &mut *state;
            let pending = pending
                .as_ref()
                .ok_or(GateError::Refused("WORKER_IMAGE_PENDING_CHANGED"))?;
            let stamp = stamp
                .as_ref()
                .ok_or(GateError::Refused("WORKER_IMAGE_SOURCE_CHANGED"))?;
            *publication = Some(files.publish_maintained_configuration(
                &self.intent,
                stamp,
                pending,
                locks,
                service,
            )?);
            Ok(())
        })();
        self.keep(result)
    }
    /// Isolated file/admission mechanism controls do not mint maintenance or
    /// service owners. The actual application only uses the maintained path.
    #[cfg(test)]
    pub(super) fn publish_configuration(self: &Arc<Self>) -> Result<()> {
        self.current()?;
        let result = (|| {
            let mut state = self.lock()?;
            let Files {
                files,
                stamp,
                pending,
                publication,
                ..
            } = &mut *state;
            let pending = pending
                .as_ref()
                .ok_or(GateError::Refused("WORKER_IMAGE_PENDING_CHANGED"))?;
            let stamp = stamp
                .as_ref()
                .ok_or(GateError::Refused("WORKER_IMAGE_SOURCE_CHANGED"))?;
            *publication = Some(files.publish_configuration(&self.intent, stamp, pending)?);
            Ok(())
        })();
        self.keep(result)
    }
    pub(in crate::reservation_gate) fn admission_closed(self: &Arc<Self>) -> Result<()> {
        self.lock()?.closed = true;
        Ok(())
    }
    pub(super) fn terminal(
        self: &Arc<Self>,
        protected: &ImageProtectedStores,
    ) -> Result<ImageTerminalSnapshot> {
        self.healthy()?;
        let result = (|| {
            let mut state = self.lock()?;
            need(state.closed, "WORKER_IMAGE_ADMISSION_NOT_CLOSED")?;
            let Files {
                files,
                pending,
                publication,
                ..
            } = &mut *state;
            Ok(files.capture_terminal(
                publication
                    .as_ref()
                    .ok_or(GateError::Refused("WORKER_IMAGE_PUBLICATION_PHASE"))?,
                pending
                    .as_ref()
                    .ok_or(GateError::Refused("WORKER_IMAGE_PENDING_CHANGED"))?,
                protected,
            )?)
        })();
        self.keep(result)
    }
    pub(super) fn release(self: &Arc<Self>, terminal: &ImageTerminalSnapshot) -> Result<()> {
        self.healthy()?;
        let result = (|| {
            let mut state = self.lock()?;
            need(state.closed, "WORKER_IMAGE_ADMISSION_NOT_CLOSED")?;
            let Files { files, pending, .. } = &mut *state;
            Ok(files.release_pending(
                pending
                    .as_mut()
                    .ok_or(GateError::Refused("WORKER_IMAGE_PENDING_CHANGED"))?,
                terminal,
            )?)
        })();
        self.keep(result)
    }
}
