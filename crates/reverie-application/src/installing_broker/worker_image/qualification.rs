use super::*;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(WorkerImageQualificationError::Refused(code))
    }
}
impl InstallingBroker {
    pub fn qualify_worker_image(
        &self,
        base: ArtifactReference,
        annex: ArtifactReference,
        image: WorkerImageId,
        end: Instant,
    ) -> std::result::Result<QualifiedWorkerImage<'_>, Box<WorkerImageQualificationFailure<'_>>>
    {
        let before = self.configuration().map_err(|cause| {
            Box::new(WorkerImageQualificationFailure {
                owner: None,
                cause: cause.into(),
            })
        })?;
        let mut owner = Box::new(Qualification {
            broker: self,
            context: NativeObserver::capture_worker(
                &self.storage.runtime,
                before.configuration().clone(),
            ),
            before,
            base,
            annex,
            image,
            input: ImmutableInputObserver::default(),
            end,
            failed: false,
            preview_files: None,
            preview: None,
            file_close_failure: None,
        });
        if let Err(cause) = owner.observe(end) {
            owner.failed = true;
            return Err(Box::new(WorkerImageQualificationFailure {
                owner: Some(owner),
                cause,
            }));
        }
        Ok(QualifiedWorkerImage { owner: Some(owner) })
    }
}
impl Qualification<'_> {
    pub(super) fn observe(&mut self, end: Instant) -> Result<()> {
        need(!self.failed, "WORKER_IMAGE_QUALIFICATION_RETAINED")?;
        let end = end.min(self.end);
        let now = Instant::now();
        need(
            end > now && self.end.duration_since(now) <= Duration::from_secs(300),
            "WORKER_IMAGE_QUALIFICATION_DEADLINE",
        )?;
        self.context
            .assert_worker_runtime(&self.broker.storage.runtime)?;
        self.context
            .inherit_worker_stop_budget(&self.broker.storage.runtime.stop_budget())?;
        let current = self.broker.configuration()?;
        need(
            current.source_path() == self.before.source_path()
                && reverie_contracts::worker_config::image_only_equivalent(
                    current.configuration(),
                    self.before.configuration(),
                ),
            "WORKER_IMAGE_QUALIFICATION_SOURCE_CHANGED",
        )?;
        let base = self
            .input
            .observe_artifact(&self.base, ImmutableInputKind::Provenance, end)?;
        let annex =
            self.input
                .observe_artifact(&self.annex, ImmutableInputKind::Provenance, end)?;
        let profile = WorkerImageProvenance::decode(&self.base, base.bytes(), annex.bytes())?;
        profile.require_identity(self.before.envelope().base().ids())?;
        self.input.observe_worker_child_program(&profile, end)?;
        for selected in profile
            .toolkit()
            .iter()
            .chain(std::iter::once(profile.manifest()))
        {
            let reference = ArtifactReference {
                path: selected.path.clone(),
                sha256: selected.sha256.clone(),
            };
            let observed =
                self.input
                    .observe_artifact(&reference, ImmutableInputKind::Provenance, end)?;
            need(
                observed.bytes().len() as u64 == selected.bytes,
                "WORKER_IMAGE_INPUT_LENGTH_CHANGED",
            )?;
            if std::ptr::eq(selected, profile.manifest()) {
                profile.require_program_manifest(observed.bytes())?;
            }
        }
        let raw = self.context.worker_image_metadata(&self.image, end)?;
        let metadata = EngineMetadata::decode(raw.as_bytes())?;
        need(
            metadata.qualify_worker_image(&profile)? == self.image.as_str(),
            "WORKER_IMAGE_ENGINE_ID_CHANGED",
        )?;
        self.rootless(current.configuration(), raw.as_bytes())?;
        self.context
            .assert_worker_runtime(&self.broker.storage.runtime)?;
        self.input.assert_finalized()?;
        need(Instant::now() < end, "WORKER_IMAGE_QUALIFICATION_DEADLINE")
    }
    fn rootless(
        &self,
        config: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        raw: &[u8],
    ) -> Result<()> {
        use reverie_contracts::rootless::{RootlessConfig, RootlessImage};
        let data = |e| {
            WorkerImageQualificationError::Rootless(
                reverie_host::rootless::RootlessHostError::Data(e),
            )
        };
        let config = RootlessConfig::capture(config.clone()).map_err(data)?;
        let image = RootlessImage::decode(raw).map_err(data)?;
        reverie_host::rootless::require_rootless_image(&config, &image)
            .map_err(WorkerImageQualificationError::Rootless)?;
        Ok(())
    }
    pub(super) fn close(&self, end: Instant) -> Result<()> {
        let input = self.file_close_failure.as_ref().map_or_else(
            || self.input.assert_finalized().map_err(Into::into),
            |error| Err(WorkerImageQualificationError::ImageFiles(error.clone())),
        );
        let query = self.context.settle_metadata_owned(end).map_err(Into::into);
        match (input, query) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
            (Err(a), Err(b)) => Err(WorkerImageQualificationError::Finalization(
                Box::new(a),
                Box::new(b),
            )),
        }
    }
}
impl<'a> QualifiedWorkerImage<'a> {
    pub fn image(&self) -> &WorkerImageId {
        &self.owner.as_ref().expect("qualified owner").image
    }
    pub fn assert_current(&mut self, end: Instant) -> Result<()> {
        let owner = self.owner.as_mut().expect("qualified owner");
        let result = owner.observe(end);
        if result.is_err() {
            owner.failed = true;
        }
        result
    }
    pub fn close(
        mut self,
        end: Instant,
    ) -> std::result::Result<(), Box<WorkerImageQualificationFailure<'a>>> {
        let owner = self.owner.take().expect("qualified owner");
        match owner.close(end) {
            Ok(()) => Ok(()),
            Err(cause) => Err(Box::new(WorkerImageQualificationFailure {
                owner: Some(owner),
                cause,
            })),
        }
    }
}
