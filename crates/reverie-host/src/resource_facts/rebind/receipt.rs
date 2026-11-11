use super::*;
impl ActorRebound {
    pub(crate) fn deadline(&self) -> Instant {
        self.0.deadline()
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        let proof = &self.0;
        check(proof.deadline())?;
        proof.after.assert_paths()?;
        let info = fs::symlink_metadata(&proof.after.path).map_err(GoalCustodyError::from)?;
        need(
            GpuFileStamp::of(&info) == proof.stamp && info.gid() == proof.group,
            "RESOURCE_INSTALL_CHANGED",
        )?;
        check(proof.deadline())
    }
}
impl ReboundProof {
    fn deadline(&self) -> Instant {
        self.stop
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop))
    }
    fn read_after(&self, files: &mut PrivateBatch) -> Result<InstalledFactsDocument> {
        need(
            files
                .inspect(
                    &self
                        .after
                        .path
                        .with_file_name("resource-actor.installing.json"),
                    false,
                    true,
                )?
                .is_none(),
            "RESOURCE_INSTALL_PENDING_REQUIRES_INSPECTION",
        )?;
        let (stamp, raw) = files.read_exact_private_json(&self.after.path)?;
        need(
            stamp == self.after.stamp
                && raw == self.after.raw
                && files.identities() == self.after.identities,
            "RESOURCE_INSTALL_CHANGED",
        )?;
        let document = InstalledFactsDocument::decode(&raw)?;
        ResourceActorSettings::capture(&self.after_config)?.require_document(&document)?;
        files.check()?;
        check(self.deadline())?;
        Ok(document)
    }
}
impl InstalledFactsObserver {
    /// Metadata-only bridge while this observer still retains the original
    /// generation. Only the checked receipt permits the expected new domain.
    pub fn assert_configuration_rebind(
        &self,
        receipt: &ActorRebound,
        after: &EffectiveWorkerConfig,
    ) -> Result<()> {
        self.assert_finalized()?;
        let proof = &receipt.0;
        need(
            Arc::ptr_eq(&self.identity, &proof.identity)
                && self.original.as_ref() == Some(&proof.before)
                && reverie_contracts::worker_config::equivalent(after, &proof.after_config),
            "RESOURCE_INSTALL_REBIND_FOREIGN",
        )?;
        receipt.assert_current()
    }
    /// Only this observer's checked publication receipt may advance its bound
    /// generation. A raw document or equal configuration cannot do so.
    pub fn accept_configuration_rebind(
        &mut self,
        receipt: &ActorRebound,
    ) -> Result<InstalledFactsDocument> {
        let proof = &receipt.0;
        self.assert_configuration_rebind(receipt, &proof.after_config)?;
        let mut files = PrivateBatch::new()?;
        let body = proof.read_after(&mut files);
        let closed = files.close().map_err(ResourceFactsError::from);
        self.close_uncertain |= closed.is_err();
        let document = finalized(body, closed)?;
        files.check()?;
        receipt.assert_current()?;
        self.original = Some(proof.after.clone());
        Ok(document)
    }
}
