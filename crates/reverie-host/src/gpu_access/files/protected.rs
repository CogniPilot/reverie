//! Fixed original worker stores shared by PERF and pool publication. No store
//! is consumed or rewritten by these metadata-only preservation observations.
use super::*;
pub(crate) struct WorkerProtectedStores(Vec<(PathBuf, Option<GpuFileStamp>)>);
impl WorkerProtectedStores {
    pub(crate) fn capture(config: &ReservationConfiguration) -> Result<Self> {
        let root = native::python_path(&config.control_paths()?.root().codepoints())?;
        let mut leaves = Vec::new();
        for leaf in [
            "admission.lock",
            "profiles/profiles.lock",
            "operations/operations.lock",
            "profiles/profiles.json",
            "operations/operations.json",
            "operations/task-perf-owner-requests.json",
        ] {
            let path = root.join(leaf);
            let stamp = GpuFileStamp::observe_optional(&path)?;
            leaves.push((path, stamp));
        }
        let requests = root.join("operations").join(REQUEST_FILE);
        leaves.push((requests.clone(), GpuFileStamp::observe_optional(&requests)?));
        Ok(Self(leaves))
    }
    pub(crate) fn capture_pool(config: &ReservationConfiguration) -> Result<Self> {
        let mut stores = Self::capture(config)?;
        let root = native::python_path(&config.control_paths()?.root().codepoints())?;
        for leaf in [
            "operations/host-job.intent.json",
            "operations/host-job.finish.pending.json",
        ] {
            let path = root.join(leaf);
            let stamp = GpuFileStamp::observe_optional(&path)?;
            stores.0.push((path, stamp));
        }
        Ok(stores)
    }
    pub(crate) fn unchanged(&self) -> Result<bool> {
        for (path, stamp) in &self.0 {
            if GpuFileStamp::observe_optional(path)?.as_ref() != stamp.as_ref() {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
