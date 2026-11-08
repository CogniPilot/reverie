//! Native deployment/image locks. These owners grant no R or service permission.
use super::*;
mod custody;
#[cfg(test)]
mod tests;
use custody::{Directory, HeldLock, Terminal};

struct Owner {
    root: PathBuf,
    source: PathBuf,
    end: Instant,
    reader: ImageControlFiles,
    uid: u32,
    directories: Vec<Directory>,
    locks: Vec<HeldLock>,
    deployment: Option<(PathBuf, ImageFileStamp)>,
    failure: Option<ImageFileError>,
    close_failure: Option<ImageFileError>,
}
#[must_use = "keep both actual locks until checked component closure"]
pub struct ImageMaintenanceLocks {
    owner: Option<Box<Owner>>,
}
/// Known closure DATA, not a held lock or a publication/admission grant.
pub struct ClosedImageMaintenance {
    source: PathBuf,
    terminal: Terminal,
}
pub struct ImageMaintenanceFailure {
    owner: Option<Box<Owner>>,
    cause: ImageFileError,
}
impl ImageMaintenanceFailure {
    pub fn cause(&self) -> &ImageFileError {
        &self.cause
    }
    /// Attempt every original descriptor once; consumed-close opacity is sticky.
    pub fn close_components(&mut self) -> Result<()> {
        let result = self.owner.as_mut().map_or(Ok(()), |owner| owner.close());
        if let Err(error) = &result
            && !self.cause.has_unconfirmed_close()
        {
            self.cause = error::finalized::<()>(Err(self.cause.clone()), Err(error.clone()))
                .expect_err("same first failure");
        }
        result
    }
}
impl std::fmt::Debug for ImageMaintenanceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ImageMaintenanceFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Display for ImageMaintenanceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for ImageMaintenanceFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl ImageMaintenanceLocks {
    pub fn capture(
        source: &Path,
        config: &EffectiveWorkerConfig,
        end: Instant,
    ) -> std::result::Result<Self, Box<ImageMaintenanceFailure>> {
        let root = native::home_directory(None)
            .map_err(ImageFileError::io)
            .and_then(|home| native::python_path(&home).map_err(ImageFileError::io))
            .map(|home| home.join("reverie"))
            .map_err(|cause| Box::new(ImageMaintenanceFailure { owner: None, cause }))?;
        Self::capture_at(&root, source, config, end)
    }
    fn capture_at(
        root: &Path,
        source: &Path,
        config: &EffectiveWorkerConfig,
        end: Instant,
    ) -> std::result::Result<Self, Box<ImageMaintenanceFailure>> {
        let mut owner = Box::new(Owner {
            root: root.to_owned(),
            source: source.to_owned(),
            end,
            reader: ImageControlFiles::capture(source, config),
            uid: native::policy_effective_uid(),
            directories: Vec::new(),
            locks: Vec::new(),
            deployment: None,
            failure: None,
            close_failure: None,
        });
        match owner.acquire(config) {
            Ok(()) => Ok(Self { owner: Some(owner) }),
            Err(cause) => {
                owner.failure = Some(cause.clone());
                Err(Box::new(ImageMaintenanceFailure {
                    owner: Some(owner),
                    cause,
                }))
            }
        }
    }
    fn owner(&self) -> &Owner {
        self.owner.as_deref().expect("original maintenance")
    }
    pub fn source(&self) -> &Path {
        &self.owner().source
    }
    pub fn end(&self) -> Instant {
        self.owner().end
    }
    pub fn assert_held_current(&mut self) -> Result<()> {
        let owner = self.owner.as_mut().expect("original maintenance");
        if let Some(error) = &owner.failure {
            return Err(error.clone());
        }
        let result = owner.current();
        if let Err(error) = &result {
            owner.failure = Some(error.clone());
        }
        result
    }
    pub fn close(
        mut self,
    ) -> std::result::Result<ClosedImageMaintenance, Box<ImageMaintenanceFailure>> {
        let body = self
            .assert_held_current()
            .and_then(|()| self.owner().terminal());
        let mut owner = self.owner.take().expect("original maintenance");
        let closed = owner.close();
        match error::finalized(body, closed) {
            Ok(terminal) => Ok(ClosedImageMaintenance {
                source: owner.source.clone(),
                terminal,
            }),
            Err(cause) => Err(Box::new(ImageMaintenanceFailure {
                owner: Some(owner),
                cause,
            })),
        }
    }
}
impl ClosedImageMaintenance {
    pub fn source(&self) -> &Path {
        &self.source
    }
    /// Recheck the SAME final named metadata without opening descriptors or
    /// claiming the already-closed locks remain held. Service/R are separate.
    pub fn assert_current(&self) -> Result<()> {
        self.terminal.current()
    }
}
impl Owner {
    fn close(&mut self) -> Result<()> {
        let mut result = self.close_failure.clone().map_or(Ok(()), Err);
        for lock in self.locks.iter_mut().rev() {
            result = error::finalized(result, lock.close());
        }
        for directory in self.directories.iter_mut().rev() {
            result = error::finalized(result, directory.close());
        }
        if let Err(error) = &result {
            self.close_failure = Some(error.clone());
        }
        result
    }
}
impl Drop for ImageMaintenanceLocks {
    fn drop(&mut self) {
        std::mem::forget(self.owner.take());
    }
}
impl Drop for ImageMaintenanceFailure {
    fn drop(&mut self) {
        std::mem::forget(self.owner.take());
    }
}
