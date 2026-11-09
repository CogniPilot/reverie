use super::*;
impl PerfState {
    pub(super) fn publish(
        &mut self,
        intent: &PerfTransition,
        config_stamp: &GpuFileStamp,
        binding_stamp: &GpuFileStamp,
        pending: &PerfPending,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> Result<PerfTerminal> {
        self.live()?;
        let result =
            self.publish_both(intent, config_stamp, binding_stamp, pending, locks, service);
        self.finish(result)
    }
    fn publish_both(
        &mut self,
        intent: &PerfTransition,
        config_stamp: &GpuFileStamp,
        binding_stamp: &GpuFileStamp,
        pending: &PerfPending,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> Result<PerfTerminal> {
        need(
            self.pending_attempted
                && !self.publication_attempted
                && self
                    .intent
                    .as_deref()
                    .is_some_and(|i| std::ptr::eq(i, intent)),
            "PERF_PUBLICATION_PHASE",
        )?;
        self.assert_pending(pending)?;
        let before = self.files.read_configuration()?;
        let binding = self.files.read_binding()?;
        need(
            before.stamp() == config_stamp
                && binding.stamp() == binding_stamp
                && intent.matches_before_configuration(before.metadata())
                && intent.matches_before_binding(binding.metadata()),
            "PERF_SOURCE_CAS_CHANGED",
        )?;
        let (source_original, source_gid) = self
            .source_stamp
            .as_ref()
            .ok_or(GpuHostError::Refused("PERF_ORIGINAL_SOURCE_REQUIRED"))?;
        let (binding_original, binding_gid) = self
            .binding_stamp
            .as_ref()
            .ok_or(GpuHostError::Refused("PERF_ORIGINAL_BINDING_REQUIRED"))?;
        need(
            source_original == config_stamp && binding_original == binding_stamp,
            "PERF_SOURCE_CAS_CHANGED",
        )?;
        let (source_gid, binding_gid) = (*source_gid, *binding_gid);
        let parents = self.capture_parents()?;
        let protected = self.protected_stores()?;
        let source = self.files.source()?.to_owned();
        let binding_path = self.files.binding_path()?;
        let mut fence = ImageRenameFence::new(&source, locks, service);
        fence
            .assert_current()
            .map_err(|e| GpuHostError::ImageFence(Box::new(e)))?;
        self.publication_attempted = true;
        let file = pending.file.as_ref().expect("same checked pending");
        let source_after = replace_image_configuration(
            &source,
            &intent.configuration_bytes(),
            config_stamp,
            source_gid,
            pending.end,
            file,
            Some(&mut fence),
        )?;
        let binding_after = replace_image_configuration(
            &binding_path,
            &intent.binding_bytes(),
            binding_stamp,
            binding_gid,
            pending.end,
            file,
            Some(&mut fence),
        )?;
        let terminal = PerfTerminal {
            brand: self.brand.clone(),
            end: pending.end,
            parents,
            protected,
            groups: vec![
                (source.clone(), source_gid),
                (binding_path.clone(), binding_gid),
            ],
            leaves: vec![
                (source, Some(source_after)),
                (binding_path, Some(binding_after)),
                (
                    file.path().to_owned(),
                    Some(GpuFileStamp::from_native(file.stamp().clone())),
                ),
            ],
        };
        terminal.assert_current()?;
        self.assert_pending(pending)?;
        Ok(terminal)
    }
}
