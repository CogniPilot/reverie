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
        match result {
            Ok(preview) => {
                self.preview = Some(preview);
                Ok(())
            }
            Err(cause) => {
                if let GateError::ImageFiles(error) = &cause
                    && error.has_unconfirmed_close()
                {
                    self.file_close_failure = Some(error.clone());
                }
                Err(cause.into())
            }
        }
    }
}
impl<'a> PreparedOfflineImageSwitch<'a> {
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
        let owner = self.owner.take().expect("same preview owner");
        match owner.close(end) {
            Ok(()) => Ok(()),
            Err(cause) => Err(Box::new(WorkerImageQualificationFailure {
                owner: Some(owner),
                cause,
            })),
        }
    }
}
