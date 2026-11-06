use super::*;
use std::os::unix::fs::MetadataExt;
type ParentStamp = (u64, u64, u32, u32, u32);
pub struct GpuParentGuard(Vec<(PathBuf, ParentStamp)>);
pub struct GpuProtectedStores(Vec<(PathBuf, Option<GpuFileStamp>)>);
pub struct GpuTerminalSnapshot(Vec<(PathBuf, Option<GpuFileStamp>)>);
impl GpuControlFiles {
    pub fn capture_parents(&self) -> Result<GpuParentGuard> {
        let mut parents = Vec::<(PathBuf, ParentStamp)>::new();
        for path in [
            self.source()?,
            &self.binding_path()?,
            &self.requests_path()?,
        ] {
            for parent in path.ancestors().skip(1) {
                let info = fs::symlink_metadata(parent)?;
                need(info.is_dir(), "GPU_PARENT_CUSTODY")?;
                let stamp = parent_identity(&info);
                retain_parent(&mut parents, parent, stamp);
            }
        }
        Ok(GpuParentGuard(parents))
    }
    pub fn protected_stores(&self) -> Result<GpuProtectedStores> {
        let root = native::python_path(&self.config.control_paths()?.root().codepoints())?;
        let mut stores = Vec::new();
        for path in [
            root.join("operations/operations.json"),
            root.join("profiles/profiles.json"),
        ] {
            let stamp = GpuFileStamp::observe_optional(&path)?;
            stores.push((path, stamp));
        }
        Ok(GpuProtectedStores(stores))
    }
    pub fn capture_terminal(
        &self,
        request: Option<&GpuFileStamp>,
        pending: &GpuPendingFile,
        protected: &GpuProtectedStores,
        cdi: Option<&CdiObservation>,
    ) -> Result<GpuTerminalSnapshot> {
        let binding = self.binding_path()?;
        let source = self.source()?.to_owned();
        let mut leaves = vec![
            (source.clone(), Some(GpuFileStamp::observe(&source)?)),
            (binding.clone(), Some(GpuFileStamp::observe(&binding)?)),
            (self.requests_path()?, request.cloned()),
            (pending.path().to_owned(), Some(pending.stamp().clone())),
        ];
        leaves.extend(protected.0.iter().cloned());
        if let Some(cdi) = cdi {
            let path = native::python_path(&cdi.path().codepoints())?;
            // Bind the last actual CDI read, rather than accepting a different
            // specification which appeared after its parsing/physical checks.
            cdi.assert_current()?;
            leaves.push((path, Some(cdi.stamp().clone())));
        }
        Ok(GpuTerminalSnapshot(leaves))
    }
    pub fn host_history_present(&self) -> Result<bool> {
        let root = native::python_path(&self.config.control_paths()?.root().codepoints())?;
        Ok(fs::symlink_metadata(root.join("operations/host-job.intent.json")).is_ok())
    }
}
fn retain_parent(parents: &mut Vec<(PathBuf, ParentStamp)>, parent: &Path, stamp: ParentStamp) {
    if let Some((_, saved)) = parents.iter_mut().find(|(name, _)| name == parent) {
        *saved = stamp;
    } else {
        parents.push((parent.to_owned(), stamp));
    }
}
impl GpuParentGuard {
    pub fn assert_current(&self) -> Result<()> {
        for (path, stamp) in &self.0 {
            let info = fs::symlink_metadata(path)?;
            need(
                (info.dev(), info.ino(), info.mode(), info.uid(), info.gid()) == *stamp,
                "GPU_PARENT_CUSTODY_CHANGED",
            )?;
        }
        Ok(())
    }
}
impl GpuTerminalSnapshot {
    pub fn assert_current(&self) -> Result<()> {
        for (path, stamp) in &self.0 {
            need(
                GpuFileStamp::observe_optional(path)?.as_ref() == stamp.as_ref(),
                "GPU_TERMINAL_CAS_CHANGED",
            )?;
        }
        Ok(())
    }
}
