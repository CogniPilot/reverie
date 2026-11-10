//! The public surface keeps the original complete attempted writer in custody.
use super::*;
impl PerfControlFiles {
    pub fn capture(source: &Path, before: &EffectiveWorkerConfig) -> Self {
        Self {
            owner: Some(Box::new(PerfState::capture(source, before))),
        }
    }
    fn owner(&mut self) -> &mut PerfState {
        self.owner
            .as_deref_mut()
            .expect("same original PERF writer")
    }
    pub fn read_configuration(&mut self) -> Result<GpuPrivateSnapshot> {
        self.owner().read_configuration()
    }
    pub fn read_binding(&mut self) -> Result<GpuPrivateSnapshot> {
        self.owner().read_binding()
    }
    pub fn host_history_present(&mut self) -> Result<bool> {
        let owner = self.owner();
        owner.live()?;
        let result = owner.files.host_history_present();
        owner.finish(result)
    }
    pub fn capture_parents(&mut self) -> Result<Arc<GpuParentGuard>> {
        self.owner().capture_parents()
    }
    pub fn protected_stores(&mut self) -> Result<Arc<PerfProtectedStores>> {
        self.owner().protected_stores()
    }
    pub fn publish_pending(
        &mut self,
        intent: Arc<PerfTransition>,
        operation: &JournalId,
        preview: &JournalDigest,
        end: Instant,
    ) -> Result<PerfPending> {
        self.owner()
            .publish_pending(intent, operation, preview, end)
    }
    pub fn publish(
        &mut self,
        intent: &PerfTransition,
        config_stamp: &GpuFileStamp,
        binding_stamp: &GpuFileStamp,
        pending: &PerfPending,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> Result<PerfTerminal> {
        self.owner()
            .publish(intent, config_stamp, binding_stamp, pending, locks, service)
    }
    pub fn release(&mut self, pending: &mut PerfPending, terminal: &PerfTerminal) -> Result<()> {
        self.owner().release(pending, terminal)
    }
}
