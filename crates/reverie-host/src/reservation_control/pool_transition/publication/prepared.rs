use super::*;
use std::os::unix::fs::MetadataExt;

impl PublicationState {
    pub(super) fn prepare(
        &mut self,
        proof: &PendingProof,
        file: &PendingFile,
        admission: &AdmissionLock,
    ) -> Result<()> {
        need(self.phase == Phase::Preparing, "POOL_PUBLICATION_PHASE")?;
        let fence = PoolRenameFence::new(proof, file, admission, &self.stop, self.end);
        fence.assert_current()?;
        need(
            reverie_contracts::worker_config::equivalent(
                proof.config.configuration(),
                self.transition.before(),
            ),
            "POOL_PUBLICATION_CONFIGURATION_CHANGED",
        )?;
        self.actor
            .assert_transition(self.transition.before(), self.transition.after())?;
        self.actor.assert_current()?;
        self.configuration = Some(self.files.read_configuration()?);
        self.binding = Some(self.files.read_binding()?);
        let configuration = self.configuration.as_ref().expect("stored original source");
        let binding = self.binding.as_ref().expect("stored original binding");
        need(
            self.transition
                .matches_before_configuration(configuration.metadata())
                && self.transition.matches_before_binding(binding.metadata())
                && proof.binding.matches_metadata(binding.metadata()),
            "POOL_PUBLICATION_SOURCE_CHANGED",
        )?;
        self.groups = Some((
            group(&self.source, configuration.stamp())?,
            group(&Self::binding_path(proof)?, binding.stamp())?,
        ));
        self.parents = Some(Arc::new(self.files.capture_parents()?));
        self.protected = Some(Arc::new(ProtectedStores::capture(proof)?));
        self.assert_before(proof)?;
        fence.assert_current()?;
        self.phase = Phase::Prepared;
        Ok(())
    }
    fn assert_before(&self, proof: &PendingProof) -> Result<()> {
        self.actor.assert_current()?;
        self.parents
            .as_ref()
            .expect("captured original parents")
            .assert_current()?;
        self.protected
            .as_ref()
            .expect("captured original stores")
            .assert_current()?;
        let config = self.files.read_configuration()?;
        let binding = self.files.read_binding()?;
        let original = self.configuration.as_ref().expect("stored original source");
        let original_binding = self.binding.as_ref().expect("stored original binding");
        need(
            config.stamp() == original.stamp()
                && binding.stamp() == original_binding.stamp()
                && self
                    .transition
                    .matches_before_configuration(config.metadata())
                && self.transition.matches_before_binding(binding.metadata()),
            "POOL_PUBLICATION_SOURCE_CHANGED",
        )?;
        let groups = self.groups.expect("captured original groups");
        need(
            group(&self.source, config.stamp())? == groups.0
                && group(&Self::binding_path(proof)?, binding.stamp())? == groups.1,
            "POOL_PUBLICATION_GROUP_CHANGED",
        )
    }
    pub(super) fn publish(
        &mut self,
        proof: &PendingProof,
        file: &PendingFile,
        admission: &AdmissionLock,
    ) -> Result<()> {
        need(self.phase == Phase::Prepared, "POOL_PUBLICATION_PHASE")?;
        self.assert_before(proof)?;
        let mut fence = PoolRenameFence::new(proof, file, admission, &self.stop, self.end);
        fence.assert_current()?;
        let groups = self.groups.expect("captured original groups");
        let config = self.configuration.as_ref().expect("stored original source");
        let binding = self.binding.as_ref().expect("stored original binding");
        let binding_path = Self::binding_path(proof)?;
        self.phase = Phase::Attempted;
        self.source_after = Some(crate::gpu_access::replace_pool_configuration(
            &self.source,
            &self.transition.configuration_bytes(),
            config.stamp(),
            groups.0,
            self.deadline(),
            file,
            &mut fence,
        )?);
        self.binding_after = Some(crate::gpu_access::replace_pool_configuration(
            &binding_path,
            &self.transition.binding_bytes(),
            binding.stamp(),
            groups.1,
            self.deadline(),
            file,
            &mut fence,
        )?);
        self.actor_after = Some(self.actor.publish(file, &mut fence, &self.stop, self.end)?);
        self.published = Some(Arc::new(PublishedSnapshot {
            leaves: vec![
                (
                    self.source.clone(),
                    self.source_after
                        .as_ref()
                        .expect("first checked CAS")
                        .clone(),
                    groups.0,
                ),
                (
                    binding_path,
                    self.binding_after
                        .as_ref()
                        .expect("second checked CAS")
                        .clone(),
                    groups.1,
                ),
            ],
            parents: self.parents.as_ref().expect("original parents").clone(),
            protected: self.protected.as_ref().expect("original stores").clone(),
            end: self.end,
            stop: self.stop.clone(),
            actor: self
                .actor_after
                .as_ref()
                .expect("third checked CAS")
                .clone(),
        }));
        self.published
            .as_ref()
            .expect("stored checked pair")
            .assert_current()?;
        fence.assert_current()?;
        self.published
            .as_ref()
            .expect("stored checked pair")
            .assert_current()?;
        self.phase = Phase::Published;
        Ok(())
    }
}
fn group(path: &Path, stamp: &GpuFileStamp) -> Result<u32> {
    let info = fs::symlink_metadata(path)?;
    need(
        GpuFileStamp::of(&info) == *stamp,
        "POOL_PUBLICATION_SOURCE_CHANGED",
    )?;
    Ok(info.gid())
}
impl ProtectedStores {
    fn capture(proof: &PendingProof) -> Result<Self> {
        Ok(Self(WorkerProtectedStores::capture_pool(&proof.config)?))
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        need(self.0.unchanged()?, "POOL_PUBLICATION_PROTECTED_CHANGED")
    }
}
