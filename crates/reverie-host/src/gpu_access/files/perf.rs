//! PERF-only source/binding publication over the existing native CAS owner.
//! These components grant no service, R, employee or launch authority.
use super::*;
use crate::{
    private_pending::PendingFile,
    worker_image::{ImageMaintenanceLocks, ImageRenameFence},
    worker_service::ImageServiceMaintenance,
};
use reverie_contracts::perf_transition::PerfTransition;
use reverie_core::operations::{JournalDigest, JournalId};
use std::{os::unix::fs::MetadataExt, sync::Arc, time::Instant};
mod interface;
mod pending;
mod publication;
mod terminal;

#[must_use = "retain the actual pending/publication attempt and its first returned cause"]
pub struct PerfControlFiles {
    owner: Option<Box<PerfState>>,
}
struct PerfState {
    files: GpuControlFiles,
    brand: Arc<()>,
    parents: Option<Arc<GpuParentGuard>>,
    protected: Option<Arc<PerfProtectedStores>>,
    source_stamp: Option<(GpuFileStamp, u32)>,
    binding_stamp: Option<(GpuFileStamp, u32)>,
    intent: Option<Arc<PerfTransition>>,
    pending_attempted: bool,
    publication_attempted: bool,
    failed: bool,
    released: bool,
}
#[must_use = "only the original PERF writer may release its actual pending"]
pub struct PerfPending {
    file: Option<PendingFile>,
    brand: Arc<()>,
    intent: Arc<PerfTransition>,
    operation: JournalId,
    preview: JournalDigest,
    end: Instant,
}
pub struct PerfProtectedStores(Vec<(PathBuf, Option<GpuFileStamp>)>);
/// Exact final file observations, never held admission or global closure.
pub struct PerfTerminal {
    brand: Arc<()>,
    leaves: Vec<(PathBuf, Option<GpuFileStamp>)>,
    groups: Vec<(PathBuf, u32)>,
    parents: Arc<GpuParentGuard>,
    protected: Arc<PerfProtectedStores>,
    end: Instant,
}
impl PerfState {
    fn capture(source: &Path, before: &EffectiveWorkerConfig) -> Self {
        Self {
            files: GpuControlFiles::capture(source, before),
            brand: Arc::new(()),
            parents: None,
            protected: None,
            source_stamp: None,
            binding_stamp: None,
            intent: None,
            pending_attempted: false,
            publication_attempted: false,
            failed: false,
            released: false,
        }
    }
    fn live(&self) -> Result<()> {
        need(!self.failed, "PERF_PUBLICATION_REQUIRES_RECONCILIATION")
    }
    // The actual App owner retains the original typed cause. This latch blocks
    // all later forward work without replacing it or growing a diagnostic tree.
    fn finish<T>(&mut self, result: Result<T>) -> Result<T> {
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn read_configuration(&mut self) -> Result<GpuPrivateSnapshot> {
        self.live()?;
        let result = (|| {
            let read = self.files.read_configuration()?;
            remember(&mut self.source_stamp, self.files.source()?, read.stamp())?;
            Ok(read)
        })();
        self.finish(result)
    }
    fn read_binding(&mut self) -> Result<GpuPrivateSnapshot> {
        self.live()?;
        let result = (|| {
            let read = self.files.read_binding()?;
            remember(
                &mut self.binding_stamp,
                &self.files.binding_path()?,
                read.stamp(),
            )?;
            Ok(read)
        })();
        self.finish(result)
    }
    fn capture_parents(&mut self) -> Result<Arc<GpuParentGuard>> {
        self.live()?;
        let result = (|| {
            if self.parents.is_none() {
                self.parents = Some(Arc::new(self.files.capture_parents()?));
            }
            let parents = self.parents.as_ref().expect("captured original parents");
            parents.assert_current()?;
            Ok(parents.clone())
        })();
        self.finish(result)
    }
    fn protected_stores(&mut self) -> Result<Arc<PerfProtectedStores>> {
        self.live()?;
        let result = (|| {
            if self.protected.is_none() {
                let root =
                    native::python_path(&self.files.config.control_paths()?.root().codepoints())?;
                let mut leaves = Vec::new();
                for path in [
                    root.join("admission.lock"),
                    root.join("profiles/profiles.lock"),
                    root.join("operations/operations.lock"),
                    root.join("profiles/profiles.json"),
                    root.join("operations/operations.json"),
                    root.join("operations/task-perf-owner-requests.json"),
                    self.files.requests_path()?,
                ] {
                    let stamp = GpuFileStamp::observe_optional(&path)?;
                    leaves.push((path, stamp));
                }
                self.protected = Some(Arc::new(PerfProtectedStores(leaves)));
            }
            let protected = self.protected.as_ref().expect("captured original stores");
            protected.assert_current()?;
            Ok(protected.clone())
        })();
        self.finish(result)
    }
}
fn remember(
    slot: &mut Option<(GpuFileStamp, u32)>,
    path: &Path,
    stamp: &GpuFileStamp,
) -> Result<()> {
    let observed = fs::symlink_metadata(path)?;
    need(GpuFileStamp::of(&observed) == *stamp, "PERF_SOURCE_CHANGED")?;
    let value = (stamp.clone(), observed.gid());
    if let Some(original) = slot {
        need(*original == value, "PERF_SOURCE_CHANGED")?;
    } else {
        *slot = Some(value);
    }
    Ok(())
}
impl Drop for PerfControlFiles {
    fn drop(&mut self) {
        if self
            .owner
            .as_ref()
            .is_some_and(|o| o.failed || (o.pending_attempted && !o.released))
        {
            std::mem::forget(self.owner.take());
        }
    }
}
