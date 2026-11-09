use super::*;
impl PerfState {
    /// The actual App must retain its attempt slot BEFORE this exclusive write.
    /// Constructor failure may leave durable partial evidence; never replay it.
    pub(super) fn publish_pending(
        &mut self,
        intent: Arc<PerfTransition>,
        operation: &JournalId,
        preview: &JournalDigest,
        end: Instant,
    ) -> Result<PerfPending> {
        self.live()?;
        let result = (|| {
            need(
                !self.pending_attempted && Instant::now() < end,
                "PERF_PENDING_PHASE",
            )?;
            need(
                reverie_contracts::worker_config::equivalent(
                    self.files.config.configuration(),
                    intent.before(),
                ),
                "PERF_CONFIGURATION_CHANGED",
            )?;
            self.capture_parents()?;
            self.protected_stores()?;
            self.intent = Some(intent.clone());
            self.pending_attempted = true;
            let path = self.files.pending_path()?;
            let parent = path
                .parent()
                .ok_or(GpuHostError::Refused("PERF_PARENT_CUSTODY"))?;
            let file = PendingFile::create(
                open_parent(parent)?,
                path,
                &intent.pending_bytes(operation, preview),
                native::policy_effective_uid(),
            )
            .map_err(super::super::pending::gpu_error)?;
            // No fallible readback follows owner construction. The consuming
            // publisher checks this SAME pending before its first CAS.
            Ok(PerfPending {
                file: Some(file),
                brand: self.brand.clone(),
                intent,
                operation: operation.clone(),
                preview: preview.clone(),
                end,
            })
        })();
        self.finish(result)
    }
    pub(super) fn assert_pending(&self, pending: &PerfPending) -> Result<()> {
        need(
            Arc::ptr_eq(&self.brand, &pending.brand)
                && self
                    .intent
                    .as_ref()
                    .is_some_and(|i| Arc::ptr_eq(i, &pending.intent)),
            "PERF_PENDING_ORIGIN",
        )?;
        let file = pending
            .file
            .as_ref()
            .ok_or(GpuHostError::Refused("PERF_PENDING_RELEASED"))?;
        need(
            file.path() == self.files.pending_path()? && Instant::now() < pending.end,
            "PERF_PENDING_CHANGED",
        )?;
        file.assert_current()
            .map_err(super::super::pending::gpu_error)?;
        let read = self.files.read_pending()?;
        need(
            read.stamp() == &GpuFileStamp::from_native(file.stamp().clone())
                && pending.intent.matches_pending_metadata(
                    read.metadata(),
                    &pending.operation,
                    &pending.preview,
                ),
            "PERF_PENDING_CHANGED",
        )
    }
    /// LAST unlink, only after all actual outer owners checked component close.
    /// A failed/unknown release is never retried and grants no closure credit.
    pub(super) fn release(
        &mut self,
        pending: &mut PerfPending,
        terminal: &PerfTerminal,
    ) -> Result<()> {
        self.live()?;
        let result = (|| {
            need(
                Arc::ptr_eq(&terminal.brand, &self.brand),
                "PERF_TERMINAL_ORIGIN",
            )?;
            terminal.assert_current()?;
            self.assert_pending(pending)?;
            pending
                .file
                .as_mut()
                .expect("same checked pending")
                .release(Some(pending.end))
                .map_err(super::super::pending::gpu_error)?;
            self.released = true;
            Ok(())
        })();
        self.finish(result)
    }
}
impl Drop for PerfPending {
    fn drop(&mut self) {
        if self.file.as_ref().is_some_and(|f| !f.confirmed()) {
            std::mem::forget((
                self.file.take(),
                self.brand.clone(),
                self.intent.clone(),
                self.operation.clone(),
                self.preview.clone(),
                self.end,
            ));
        }
    }
}
