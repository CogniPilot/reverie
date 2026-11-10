use super::*;
impl ActorSetupControlFiles {
    pub fn capture(source: &Path, before: &EffectiveWorkerConfig) -> Self {
        Self {
            owner: Some(Box::new(SetupState {
                files: GpuControlFiles::capture(source, before),
                brand: Arc::new(()),
                causes: Rc::new(RefCell::new(Causes::default())),
                source: None,
                raw: None,
                captured_source: None,
                captured_binding: None,
                binding: None,
                groups: None,
                intent: None,
                facts: None,
                parents: None,
                protected: None,
                pending_attempted: false,
                publication_attempted: false,
                components_closed: false,
                released: false,
            })),
        }
    }
    fn owner(&mut self) -> &mut SetupState {
        self.owner
            .as_deref_mut()
            .expect("original actor setup writer")
    }
    pub fn read_configuration(&mut self) -> SetupResult<GpuPrivateSnapshot> {
        self.owner().read_configuration()
    }
    pub fn read_binding(&mut self) -> SetupResult<GpuPrivateSnapshot> {
        self.owner().read_binding()
    }
    pub fn prepare_transition(
        &mut self,
        binding: &ControlBinding,
    ) -> SetupResult<Arc<ActorSetupTransition>> {
        self.owner().prepare_transition(binding)
    }
    pub fn publish_pending(
        &mut self,
        intent: Arc<ActorSetupTransition>,
        facts: ActorSetupFacts,
        operation: &JournalId,
        preview: &JournalDigest,
        end: Instant,
    ) -> SetupResult<ActorSetupPending> {
        self.owner()
            .publish_pending(intent, facts, operation, preview, end)
    }
    pub fn publish(
        &mut self,
        pending: &ActorSetupPending,
        admission: &AdmissionLock,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> SetupResult<ActorSetupTerminal> {
        self.owner().publish(pending, admission, locks, service)
    }
    pub fn release(
        &mut self,
        pending: &mut ActorSetupPending,
        terminal: &ActorSetupTerminal,
    ) -> SetupResult<()> {
        self.owner().release(pending, terminal)
    }
    pub fn primary_error(&self) -> Option<Rc<ActorSetupControlError>> {
        self.owner
            .as_ref()
            .and_then(|o| o.causes.borrow().primary.clone())
    }
    pub fn cleanup_error(&self) -> Option<Rc<ActorSetupControlError>> {
        self.owner
            .as_ref()
            .and_then(|o| o.causes.borrow().cleanup.clone())
    }
    /// Checked closure of the original native facts components on a failed
    /// prefix. A failure remains failed and no publication/release is enabled.
    pub fn close_components(&mut self) -> SetupResult<()> {
        let o = self.owner();
        o.components_closed = true;
        if let Some(facts) = o.facts.as_mut() {
            facts
                .close()
                .map_err(|e| o.causes.borrow_mut().facts_close(e))?;
        }
        Ok(())
    }
}
