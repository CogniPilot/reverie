use super::*;
impl SetupState {
    pub(super) fn publish(
        &mut self,
        pending: &ActorSetupPending,
        admission: &AdmissionLock,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> SetupResult<ActorSetupTerminal> {
        self.live()?;
        self.host(need(
            !self.publication_attempted && !self.components_closed,
            "ACTOR_SETUP_ALREADY_ATTEMPTED",
        ))?;
        self.host(self.assert_pending(pending))?;
        self.host(self.assert_before())?;
        let source = self.host(self.files.source().map(Path::to_owned))?;
        let binding = self.host(self.files.binding_path())?;
        let actor = pending.proof.root.join("resource-actor.json");
        let groups = self.groups.expect("original groups");
        let source_stamp = self
            .source
            .as_ref()
            .expect("original source")
            .stamp()
            .clone();
        let binding_stamp = self
            .binding
            .as_ref()
            .expect("original binding")
            .stamp()
            .clone();
        let parents = self.parents.as_ref().expect("original parents").clone();
        let protected = self
            .protected
            .as_ref()
            .expect("original protected stores")
            .clone();
        let causes = self.causes.clone();
        let facts = self.facts.as_mut().expect("stored original facts");
        let mut fence = ActorSetupRenameFence {
            admission,
            image: ImageRenameFence::new(&source, locks, service),
            pending,
            facts,
            causes: causes.clone(),
            parents: &parents,
            protected: &protected,
        };
        self.publication_attempted = true;
        let result = publish_three(
            &source,
            &binding,
            &actor,
            (source_stamp, binding_stamp),
            groups,
            &mut fence,
        );
        let leaves = result.map_err(|e| causes.borrow_mut().host(e))?;
        // All native-current observations precede checked closure. The final
        // terminal checks use immutable receipts and original named metadata.
        fence
            .assert_current()
            .map_err(|e| causes.borrow_mut().host(e))?;
        fence
            .facts
            .close()
            .map_err(|e| causes.borrow_mut().record(ActorSetupControlError::Facts(e)))?;
        fence.metadata().map_err(|e| causes.borrow_mut().host(e))?;
        let terminal = ActorSetupTerminal {
            proof: pending.proof.clone(),
            parents,
            protected,
            leaves,
        };
        self.host(terminal.current())?;
        Ok(terminal)
    }
}
fn publish_three(
    source: &Path,
    binding: &Path,
    actor: &Path,
    stamps: (GpuFileStamp, GpuFileStamp),
    groups: (u32, u32),
    fence: &mut ActorSetupRenameFence<'_>,
) -> Result<Vec<(PathBuf, GpuFileStamp, u32)>> {
    let proof = fence.pending.proof.clone();
    let pending = fence.pending;
    let file = pending.file.as_ref().expect("same actual pending");
    let source_after = replace_actor_configuration(
        source,
        proof.intent.configuration_bytes(),
        Some(&stamps.0),
        groups.0,
        proof.deadline(),
        file,
        fence,
    )?;
    let binding_after = replace_actor_configuration(
        binding,
        &proof.intent.binding_bytes(),
        Some(&stamps.1),
        groups.1,
        proof.deadline(),
        file,
        fence,
    )?;
    let actor_group = fs::symlink_metadata(&proof.root)?.gid();
    let actor_after = publish_absent_actor(
        actor,
        &proof.facts_raw,
        actor_group,
        proof.deadline(),
        file,
        fence,
    )?;
    Ok(vec![
        (source.to_owned(), source_after, groups.0),
        (binding.to_owned(), binding_after, groups.1),
        (actor.to_owned(), actor_after, actor_group),
    ])
}
