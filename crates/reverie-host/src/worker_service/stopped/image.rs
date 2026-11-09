//! The service marker remains until the image operation's final outer release.
use super::*;

pub(super) struct PendingStamp(fs::Metadata);
impl PendingStamp {
    fn current(&self, path: &Path) -> Result<()> {
        private(path, false)?;
        let observed = fs::symlink_metadata(path)?;
        let original = &self.0;
        need(
            original.dev() == observed.dev()
                && original.ino() == observed.ino()
                && original.mode() == observed.mode()
                && original.uid() == observed.uid()
                && original.gid() == observed.gid()
                && original.nlink() == observed.nlink()
                && original.len() == observed.len()
                && original.mtime() == observed.mtime()
                && original.mtime_nsec() == observed.mtime_nsec()
                && original.ctime() == observed.ctime()
                && original.ctime_nsec() == observed.ctime_nsec(),
            "NATIVE_SERVICE_IMAGE_PENDING_CHANGED",
        )
    }
}
#[must_use = "retain the original image service fence through publication"]
pub struct ImageServiceMaintenance {
    proof: StoppedWorkerService,
}
#[must_use = "release this outer service fence only after the image R pending closes"]
pub struct ClosedImageServiceMaintenance {
    proof: Option<StoppedWorkerService>,
}
impl StoppedWorkerService {
    pub fn begin_image_transition(
        mut self,
    ) -> std::result::Result<ImageServiceMaintenance, Box<StoppedServiceFailure>> {
        let result = self.acquire_image_fence();
        if let Err(primary) = result {
            return Err(Box::new(StoppedServiceFailure {
                owner: Some(self),
                primary,
            }));
        }
        let mut guard = ImageServiceMaintenance { proof: self };
        match guard.revalidate() {
            Ok(()) => Ok(guard),
            Err(primary) => Err(Box::new(StoppedServiceFailure {
                owner: Some(guard.proof),
                primary,
            })),
        }
    }
    fn acquire_image_fence(&mut self) -> Result<()> {
        self.revalidate()?;
        let owner = self.owner.as_mut().expect("same original service");
        need(
            owner.generation.as_ref() == Some(&owner.state.unit),
            "NATIVE_SERVICE_IMAGE_REQUIRES_NATIVE_INSTALLATION",
        )?;
        owner.state.assert_no_native_actor()?;
        owner.state.begin_image_attempt()?;
        let path = owner.state.folder().join("pending");
        private(&path, false)?;
        owner.image_stamp = Some(PendingStamp(fs::symlink_metadata(path)?));
        owner.state.assert_no_native_actor()
    }
}
impl ImageServiceMaintenance {
    /// Only original named source/generation/pending/process fences; this
    /// opens no FD and cannot repeat a manager query inside the final rename.
    pub(crate) fn assert_publication_current(&self, source: &Path) -> Result<()> {
        need(
            self.source() == source,
            "NATIVE_SERVICE_IMAGE_SOURCE_CHANGED",
        )?;
        private(source, false)?;
        self.proof.assert_image_fence()
    }
    pub fn source(&self) -> &Path {
        self.proof.source()
    }
    pub fn end(&self) -> Instant {
        self.proof.end()
    }
    pub fn origin(&self) -> StoppedServiceOrigin {
        self.proof.origin()
    }
    pub fn revalidate(&mut self) -> Result<()> {
        self.proof.assert_image_fence()?;
        self.proof.revalidate()?;
        self.proof.assert_image_fence()
    }
    pub fn close(
        mut self,
    ) -> std::result::Result<ClosedImageServiceMaintenance, Box<StoppedServiceFailure>> {
        let body = self.revalidate();
        let closed = self.proof.close_components();
        match finalized(body, closed) {
            Ok(()) => Ok(ClosedImageServiceMaintenance {
                proof: Some(self.proof),
            }),
            Err(primary) => Err(Box::new(StoppedServiceFailure {
                owner: Some(self.proof),
                primary,
            })),
        }
    }
}
impl ClosedImageServiceMaintenance {
    pub fn source(&self) -> &Path {
        self.proof.as_ref().expect("same closed service").source()
    }
    pub fn belongs_to(&self, origin: &StoppedServiceOrigin) -> bool {
        Arc::ptr_eq(
            &self.proof.as_ref().expect("same closed service").origin().0,
            &origin.0,
        )
    }
    /// Final outer release. The application must already have checked all image,
    /// engine, maintenance and R owners, including the actual R pending release.
    pub fn release(
        mut self,
    ) -> std::result::Result<ClosedStoppedWorkerService, Box<StoppedServiceFailure>> {
        let mut proof = self.proof.take().expect("same closed service");
        let result = proof.assert_image_fence().and_then(|()| {
            proof
                .owner
                .as_mut()
                .expect("same closed service")
                .state
                .finish_attempt()
        });
        match result {
            Ok(()) => {
                let owner = proof.owner.take().expect("same released owner");
                Ok(ClosedStoppedWorkerService {
                    source: owner.state.source.clone(),
                    generation: owner.generation.clone().expect("same native generation"),
                    origin: owner.origin.clone(),
                })
            }
            Err(primary) => Err(Box::new(StoppedServiceFailure {
                owner: Some(proof),
                primary,
            })),
        }
    }
}
impl StoppedWorkerService {
    fn assert_image_fence(&self) -> Result<()> {
        let owner = self.owner.as_ref().expect("original image service");
        need(
            Instant::now() < owner.state.end,
            "NATIVE_SERVICE_IMAGE_DEADLINE",
        )?;
        need(
            owner.generation.as_ref() == Some(&owner.state.unit)
                && owner.state.selected_unit_link()? == owner.state.unit,
            "NATIVE_SERVICE_IMAGE_GENERATION_CHANGED",
        )?;
        owner.state.assert_no_native_actor()?;
        owner
            .image_stamp
            .as_ref()
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_SERVICE_IMAGE_FENCE_REQUIRED",
            ))?
            .current(&owner.state.folder().join("pending"))
    }
}
