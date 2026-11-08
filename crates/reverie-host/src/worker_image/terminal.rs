use super::*;
type ParentIdentity = (u64, u64, u32, u32, u32);
pub struct ImageParentGuard(Vec<(PathBuf, ParentIdentity)>);
pub struct ImageProtectedStores {
    brand: Arc<()>,
    leaves: Vec<(PathBuf, Option<ImageFileStamp>)>,
    parents: ImageParentGuard,
}
pub struct ImageTerminalSnapshot {
    brand: Arc<()>,
    pending: gpu_access::GpuFileStamp,
    leaves: Vec<(PathBuf, Option<ImageFileStamp>)>,
    parents: ImageParentGuard,
}
fn optional(path: &Path) -> Result<Option<ImageFileStamp>> {
    match ImageFileStamp::observe(path) {
        Ok(stamp) => Ok(Some(stamp)),
        Err(error) if error::not_found(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
fn parent_identity(info: &fs::Metadata) -> ParentIdentity {
    (info.dev(), info.ino(), info.mode(), info.uid(), info.gid())
}
impl ImageControlFiles {
    pub fn capture_parents(&mut self) -> Result<ImageParentGuard> {
        self.live()?;
        let result = self.parents();
        self.finish(result)
    }
    fn parents(&self) -> Result<ImageParentGuard> {
        let paths = self
            .owner()
            .config
            .control_paths()
            .map_err(ImageFileError::configuration)?;
        let control =
            native::python_path(&paths.root().codepoints()).map_err(ImageFileError::io)?;
        let binding =
            native::python_path(&paths.binding().codepoints()).map_err(ImageFileError::io)?;
        let mut observed = std::collections::BTreeMap::new();
        for leaf in [
            &self.owner().source,
            &binding,
            &control.join("profiles/profiles.json"),
            &control.join("operations/operations.json"),
        ] {
            reverie_store::storage_identity::canonical(leaf).map_err(ImageFileError::identity)?;
            for parent in leaf.ancestors().skip(1) {
                let info = fs::symlink_metadata(parent).map_err(ImageFileError::io)?;
                require(info.is_dir(), "WORKER_IMAGE_PARENT_CHANGED")?;
                observed.insert(parent.to_owned(), parent_identity(&info));
            }
        }
        Ok(ImageParentGuard(observed.into_iter().collect()))
    }
    pub fn protected_stores(&mut self) -> Result<ImageProtectedStores> {
        self.live()?;
        let result = self.protected();
        self.finish(result)
    }
    fn protected(&self) -> Result<ImageProtectedStores> {
        let paths = self
            .owner()
            .config
            .control_paths()
            .map_err(ImageFileError::configuration)?;
        let control =
            native::python_path(&paths.root().codepoints()).map_err(ImageFileError::io)?;
        let binding =
            native::python_path(&paths.binding().codepoints()).map_err(ImageFileError::io)?;
        let mut leaves = Vec::new();
        for path in [
            binding,
            control.join("admission.lock"),
            control.join("profiles/profiles.lock"),
            control.join("operations/operations.lock"),
            control.join("profiles/profiles.json"),
            control.join("operations/operations.json"),
        ] {
            let stamp = optional(&path)?;
            leaves.push((path, stamp));
        }
        Ok(ImageProtectedStores {
            brand: self.owner().brand.clone(),
            leaves,
            parents: self.parents()?,
        })
    }
    pub fn capture_terminal(
        &mut self,
        publication: &ImagePublication,
        pending: &ImagePendingFile,
        protected: &ImageProtectedStores,
    ) -> Result<ImageTerminalSnapshot> {
        self.live()?;
        let result = self.terminal(publication, pending, protected);
        self.finish(result)
    }
    fn terminal(
        &self,
        publication: &ImagePublication,
        pending: &ImagePendingFile,
        protected: &ImageProtectedStores,
    ) -> Result<ImageTerminalSnapshot> {
        require(
            Arc::ptr_eq(&self.owner().brand, &publication.brand)
                && Arc::ptr_eq(&self.owner().brand, &protected.brand),
            "WORKER_IMAGE_FOREIGN_OWNER",
        )?;
        self.assert_pending(pending)?;
        let after = self.read(&self.owner().source)?;
        require(
            after.stamp == publication.stamp
                && after.bytes() == pending.intent.configuration_bytes(),
            "WORKER_IMAGE_READBACK_CHANGED",
        )?;
        protected.assert_current()?;
        let mut leaves = protected.leaves.clone();
        leaves.push((self.owner().source.clone(), Some(after.stamp)));
        let file = pending.file.as_ref().expect("checked original pending");
        leaves.push((
            file.path().to_owned(),
            Some(ImageFileStamp::observe(file.path())?),
        ));
        Ok(ImageTerminalSnapshot {
            brand: self.owner().brand.clone(),
            pending: gpu_access::GpuFileStamp::from_native(file.stamp().clone()),
            leaves,
            parents: ImageParentGuard(protected.parents.0.clone()),
        })
    }
    /// App invokes this only AFTER every actual maintenance/admission/native
    /// owner has checked close. No descriptor is opened or closed after unlink.
    pub fn release_pending(
        &mut self,
        pending: &mut ImagePendingFile,
        terminal: &ImageTerminalSnapshot,
    ) -> Result<()> {
        self.live()?;
        let result = self.release(pending, terminal);
        self.finish(result)
    }
    fn release(
        &mut self,
        pending: &mut ImagePendingFile,
        terminal: &ImageTerminalSnapshot,
    ) -> Result<()> {
        require(
            Arc::ptr_eq(&self.owner().brand, &terminal.brand)
                && Arc::ptr_eq(&self.owner().brand, &pending.brand),
            "WORKER_IMAGE_FOREIGN_OWNER",
        )?;
        let file = pending
            .file
            .as_mut()
            .ok_or_else(|| ImageFileError::refused("WORKER_IMAGE_PENDING_RELEASED"))?;
        require(
            gpu_access::GpuFileStamp::from_native(file.stamp().clone()) == terminal.pending,
            "WORKER_IMAGE_PENDING_CHANGED",
        )?;
        terminal.assert_current()?;
        file.release(Some(pending.end))
            .map_err(ImageFileError::pending)?;
        self.owner.as_mut().expect("original owner").released = true;
        Ok(())
    }
}
impl ImageParentGuard {
    pub fn assert_current(&self) -> Result<()> {
        for (path, expected) in &self.0 {
            let observed = fs::symlink_metadata(path).map_err(ImageFileError::io)?;
            require(
                observed.is_dir() && parent_identity(&observed) == *expected,
                "WORKER_IMAGE_PARENT_CHANGED",
            )?;
        }
        Ok(())
    }
}
impl ImageProtectedStores {
    pub fn assert_current(&self) -> Result<()> {
        self.parents.assert_current()?;
        assert_leaves(&self.leaves)
    }
}
impl ImageTerminalSnapshot {
    pub fn assert_current(&self) -> Result<()> {
        self.parents.assert_current()?;
        assert_leaves(&self.leaves)
    }
}
fn assert_leaves(leaves: &[(PathBuf, Option<ImageFileStamp>)]) -> Result<()> {
    for (path, expected) in leaves {
        require(
            optional(path)? == *expected,
            "WORKER_IMAGE_TERMINAL_CHANGED",
        )?;
    }
    Ok(())
}
