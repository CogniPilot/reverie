use super::*;
use reverie_core::operations::JournalDigest;
impl<'a> QualifiedWorkerImage<'a> {
    pub fn prepare_offline_switch(
        mut self,
    ) -> std::result::Result<PreparedOfflineImageSwitch<'a>, Box<WorkerImageQualificationFailure<'a>>>
    {
        let mut owner = self.owner.take().expect("same native qualifier");
        if let Err(cause) = owner.prepare() {
            owner.failed = true;
            return Err(Box::new(WorkerImageQualificationFailure {
                owner: Some(owner),
                cause,
            }));
        }
        Ok(PreparedOfflineImageSwitch { owner: Some(owner) })
    }
}
impl Qualification<'_> {
    fn prepare(&mut self) -> Result<()> {
        self.observe(self.end)?;
        self.begin_preflight()?;
        let source = self
            .before
            .source_path()
            .ok_or(WorkerImageQualificationError::Refused(
                "WORKER_IMAGE_REGISTERED_SOURCE_REQUIRED",
            ))?;
        let gate =
            self.broker
                .resource_reservations()?
                .ok_or(WorkerImageQualificationError::Refused(
                    "WORKER_IMAGE_EXISTING_R_REQUIRED",
                ))?;
        self.preview_files = Some(reverie_host::worker_image::ImageControlFiles::capture(
            source,
            self.before.configuration(),
        ));
        let result = gate.preview_offline_image(
            self.preview_files.as_mut().expect("retained actual files"),
            &self.before,
            &self.image,
            &self.base,
            &self.annex,
            self.end,
        );
        let body = match result {
            Ok(preview) => {
                self.preview = Some(preview);
                Ok(())
            }
            Err(cause) => {
                if let Some(error) = image_file_error(&cause)
                    && error.has_unconfirmed_close()
                {
                    self.file_close_failure = Some(error.clone());
                }
                Err(cause.into())
            }
        };
        let closed = self.close_preflight();
        match (body, closed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
            (Err(a), Err(b)) => Err(WorkerImageQualificationError::Finalization(
                Box::new(a),
                Box::new(b),
            )),
        }
    }
}
/// Preserve the original typed file cause through the actual admission's
/// finalization tree. Prefer an intrinsic close failure from EITHER branch;
/// a known body I/O error must not hide the cleanup branch's close opacity.
pub(super) fn image_file_error(
    error: &GateError,
) -> Option<&reverie_host::worker_image::ImageFileError> {
    match error {
        GateError::ImageFiles(error) => Some(error),
        GateError::ImageTransition(error) => image_file_error(error),
        GateError::Finalization { primary, secondary } => {
            let first = image_file_error(primary);
            let second = image_file_error(secondary);
            first
                .filter(|error| error.has_unconfirmed_close())
                .or_else(|| second.filter(|error| error.has_unconfirmed_close()))
                .or(first)
                .or(second)
        }
        GateError::ClaimUncertain { cause }
        | GateError::GpuApplyUncertain { cause }
        | GateError::NativeStartIntentUncertain { cause }
        | GateError::NativeSourceStopUncertain { cause }
        | GateError::PreparationConfigUncertain { cause }
        | GateError::PreparationIntentUncertain { cause }
        | GateError::PreparationPublicationUncertain { cause } => image_file_error(cause),
        _ => None,
    }
}
impl<'a> PreparedOfflineImageSwitch<'a> {
    /// Full original native input/engine and admitted preview reobservation.
    /// Invoke before the short stopped-service fence; this renews no deadline.
    pub fn assert_current(&mut self, end: Instant) -> Result<()> {
        let owner = self.owner.as_mut().expect("same prepared owner");
        let result = (|| {
            owner.observe(end)?;
            owner.begin_preflight()?;
            let gate = owner.broker.resource_reservations()?.ok_or(
                WorkerImageQualificationError::Refused("WORKER_IMAGE_EXISTING_R_REQUIRED"),
            )?;
            let result = gate.assert_image_preview(
                owner.preview.as_ref().expect("actual frozen preview"),
                owner.preview_files.as_mut().expect("retained actual files"),
                end.min(owner.end),
            );
            if let Err(cause) = &result
                && let Some(error) = image_file_error(cause)
                && error.has_unconfirmed_close()
            {
                owner.file_close_failure = Some(error.clone());
            }
            Ok(result?)
        })();
        let closed = owner.close_preflight();
        let result = match (result, closed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
            (Err(a), Err(b)) => Err(WorkerImageQualificationError::Finalization(
                Box::new(a),
                Box::new(b),
            )),
        };
        match result {
            Ok(()) => Ok(()),
            Err(cause) => Err(owner.latch_recheck_failure(cause)),
        }
    }
    pub fn preview_digest(&self) -> &JournalDigest {
        self.owner
            .as_ref()
            .expect("same preview owner")
            .preview
            .as_ref()
            .expect("actual frozen preview")
            .digest()
    }
    pub fn image(&self) -> &WorkerImageId {
        &self.owner.as_ref().expect("same preview owner").image
    }
    pub fn close(
        mut self,
        end: Instant,
    ) -> std::result::Result<(), Box<WorkerImageQualificationFailure<'a>>> {
        let mut owner = self.owner.take().expect("same preview owner");
        match owner.close(end) {
            Ok(()) => Ok(()),
            Err(cause) => Err(Box::new(WorkerImageQualificationFailure {
                owner: Some(owner),
                cause,
            })),
        }
    }
}
