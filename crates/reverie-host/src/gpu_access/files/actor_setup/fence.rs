use super::*;
/// Closed actor-setup purpose. The same R, actual stopped service, native facts
/// and original pending are checked at each actual CAS, including after waits.
pub(crate) struct ActorSetupRenameFence<'a> {
    pub(super) admission: &'a AdmissionLock,
    pub(super) image: ImageRenameFence<'a>,
    pub(super) pending: &'a ActorSetupPending,
    pub(super) facts: &'a mut ActorSetupFacts,
    pub(super) causes: Rc<RefCell<Causes>>,
    pub(super) parents: &'a GpuParentGuard,
    pub(super) protected: &'a WorkerProtectedStores,
}
impl ActorSetupRenameFence<'_> {
    pub(crate) fn assert_current(&mut self) -> Result<()> {
        self.metadata()?;
        if let Err(cause) = self.facts.assert_current() {
            self.causes
                .borrow_mut()
                .record(ActorSetupControlError::Facts(cause));
            return Err(GpuHostError::Refused("ACTOR_SETUP_FACTS_CHANGED"));
        }
        self.metadata()
    }
    pub(super) fn metadata(&mut self) -> Result<()> {
        self.pending.assert_current()?;
        self.parents.assert_current()?;
        need(self.protected.unchanged()?, "ACTOR_SETUP_PROTECTED_CHANGED")?;
        self.admission
            .assert_current(
                &ReservationConfiguration::capture(self.pending.proof.intent.before().clone()),
                self.pending.proof.intent.before_binding(),
            )
            .map_err(|e| GpuHostError::AdmissionFence(Box::new(e)))?;
        self.image
            .assert_current()
            .map_err(|e| GpuHostError::ImageFence(Box::new(e)))?;
        self.pending.assert_current()
    }
}
