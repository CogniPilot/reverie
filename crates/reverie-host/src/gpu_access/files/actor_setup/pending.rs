use super::*;
impl SetupState {
    pub(super) fn publish_pending(
        &mut self,
        intent: Arc<ActorSetupTransition>,
        facts: ActorSetupFacts,
        operation: &JournalId,
        preview: &JournalDigest,
        end: Instant,
    ) -> SetupResult<ActorSetupPending> {
        // Store the actual native owners before any native observation. Invalid
        // repeated input is retained, never used as a replacement/retry owner.
        if self.facts.is_some() {
            std::mem::forget(facts);
            return Err(self.refuse("ACTOR_SETUP_ALREADY_ATTEMPTED"));
        }
        self.facts = Some(facts);
        self.live()?;
        self.host(need(
            !self.pending_attempted
                && !self.components_closed
                && self
                    .intent
                    .as_ref()
                    .is_some_and(|i| Arc::ptr_eq(i, &intent)),
            "ACTOR_SETUP_TRANSITION_ORIGIN",
        ))?;
        self.host(self.assert_before())?;
        self.parents = Some(Arc::new(self.host(self.files.capture_parents())?));
        self.protected = Some(Arc::new(
            self.host(WorkerProtectedStores::capture_pool(&self.files.config))?,
        ));
        let facts = self.facts.as_mut().expect("stored original facts");
        if !facts.matches_configuration(intent.after()) {
            return Err(self.refuse("ACTOR_SETUP_FACTS_CONFIGURATION"));
        }
        let stop = facts.stop_budget();
        let end = end.min(facts.publication_deadline());
        let deadline = stop.deadline().map_or(end, |s| end.min(s));
        if Instant::now() >= deadline {
            return Err(self.refuse("ACTOR_SETUP_DEADLINE"));
        }
        self.facts
            .as_mut()
            .expect("original facts")
            .assert_current()
            .map_err(|e| {
                self.causes
                    .borrow_mut()
                    .record(ActorSetupControlError::Facts(e))
            })?;
        let raw = self
            .facts
            .as_ref()
            .expect("observed facts")
            .document_bytes()
            .map_err(|e| {
                self.causes
                    .borrow_mut()
                    .record(ActorSetupControlError::Facts(e))
            })?
            .to_vec();
        self.create_pending(intent, operation, preview, stop, end, raw)
    }
    fn create_pending(
        &mut self,
        intent: Arc<ActorSetupTransition>,
        operation: &JournalId,
        preview: &JournalDigest,
        stop: WorkerStopBudget,
        end: Instant,
        raw: Vec<u8>,
    ) -> SetupResult<ActorSetupPending> {
        let digest = {
            use sha2::Digest;
            let bytes = sha2::Sha256::digest(&raw);
            let text = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
            JournalDigest::parse(&text).expect("SHA256 has exact digest syntax")
        };
        self.host(self.assert_before())?;
        let path = self.host(self.files.pending_path())?;
        let paths = self.host(
            self.files
                .config
                .control_paths()
                .map_err(GpuHostError::from),
        )?;
        let root =
            self.host(native::python_path(&paths.root().codepoints()).map_err(Into::into))?;
        let actor =
            self.host(native::python_path(&intent.actor_path().codepoints()).map_err(Into::into))?;
        let absent = self.host(GpuFileStamp::observe_optional(&actor))?.is_none();
        self.host(need(
            actor == root.join("resource-actor.json")
                && (if self.refresh {
                    !absent && self.previous_actor.is_some()
                } else {
                    absent
                }),
            "ACTOR_SETUP_ACTOR_ALREADY_PRESENT",
        ))?;
        self.host(need(
            Instant::now() < stop.deadline().map_or(end, |s| end.min(s)),
            "ACTOR_SETUP_DEADLINE",
        ))?;
        self.pending_attempted = true;
        let directory = self.host(open_parent(
            path.parent()
                .ok_or_else(|| self.refuse("ACTOR_SETUP_PENDING_PARENT"))?,
        ))?;
        let created = PendingFile::create(
            directory,
            path.clone(),
            &intent.pending_bytes(operation, preview, &digest),
            native::policy_effective_uid(),
        );
        let file = self.host(created.map_err(super::super::pending::gpu_error))?;
        let stamp = GpuFileStamp::from_native(file.stamp().clone());
        Ok(ActorSetupPending {
            file: Some(file),
            proof: Arc::new(PendingProof {
                brand: self.brand.clone(),
                intent,
                operation: operation.clone(),
                preview: preview.clone(),
                facts_digest: digest,
                facts_raw: raw,
                root,
                path,
                stamp,
                end,
                stop,
            }),
        })
    }
    pub(super) fn assert_pending(&self, pending: &ActorSetupPending) -> Result<()> {
        need(
            Arc::ptr_eq(&self.brand, &pending.proof.brand)
                && self
                    .intent
                    .as_ref()
                    .is_some_and(|i| Arc::ptr_eq(i, &pending.proof.intent)),
            "ACTOR_SETUP_PENDING_ORIGIN",
        )?;
        pending.assert_current()
    }
    pub(super) fn release(
        &mut self,
        pending: &mut ActorSetupPending,
        terminal: &ActorSetupTerminal,
    ) -> SetupResult<()> {
        self.live()?;
        self.host(need(
            Arc::ptr_eq(&self.brand, &terminal.proof.brand)
                && Arc::ptr_eq(&pending.proof, &terminal.proof),
            "ACTOR_SETUP_TERMINAL_ORIGIN",
        ))?;
        self.host(terminal.current())?;
        self.host(self.assert_pending(pending))?;
        let proof = &pending.proof;
        let result = pending
            .file
            .as_mut()
            .expect("same original pending")
            .release_with_stop(proof.end, &proof.stop)
            .map_err(super::super::pending::gpu_error);
        self.host(result)?;
        self.released = true;
        Ok(())
    }
}
impl PendingProof {
    pub(super) fn deadline(&self) -> Instant {
        self.stop.deadline().map_or(self.end, |s| self.end.min(s))
    }
    pub(super) fn current(&self) -> Result<()> {
        need(Instant::now() < self.deadline(), "ACTOR_SETUP_DEADLINE")?;
        need(
            GpuFileStamp::observe(&self.path)? == self.stamp,
            "ACTOR_SETUP_PENDING_CHANGED",
        )?;
        let data = storage_identity::read_ordered_metadata(
            &self.path,
            native::policy_effective_uid(),
            MAX_BYTES,
        )?;
        need(
            self.intent.matches_pending_metadata(
                &data,
                &self.operation,
                &self.preview,
                &self.facts_digest,
            ) && GpuFileStamp::observe(&self.path)? == self.stamp,
            "ACTOR_SETUP_PENDING_CHANGED",
        )?;
        need(Instant::now() < self.deadline(), "ACTOR_SETUP_DEADLINE")
    }
}
impl ActorSetupPending {
    pub(super) fn assert_current(&self) -> Result<()> {
        self.file
            .as_ref()
            .ok_or(GpuHostError::Refused("ACTOR_SETUP_PENDING_RELEASED"))?
            .assert_current()
            .map_err(super::super::pending::gpu_error)?;
        self.proof.current()
    }
    pub fn assert_history_additions(
        &self,
        root: &Path,
    ) -> SetupResult<Vec<(PathBuf, GpuFileStamp)>> {
        self.assert_current()
            .map_err(|e| Rc::new(ActorSetupControlError::Host(e)))?;
        need(root == self.proof.root, "ACTOR_SETUP_HISTORY_ROOT")
            .map_err(|e| Rc::new(ActorSetupControlError::Host(e)))?;
        Ok(if self.proof.path.parent() == Some(root) {
            vec![(self.proof.path.clone(), self.proof.stamp.clone())]
        } else {
            Vec::new()
        })
    }
}
