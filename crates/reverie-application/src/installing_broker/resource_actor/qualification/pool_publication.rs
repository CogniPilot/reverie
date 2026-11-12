//! Exact staged publication: native actor CAS completed, while the original
//! App snapshot/controller tuple has not yet been atomically installed.
use super::*;
use crate::reservation_gate::PublishedPool;
use reverie_host::resource_facts::ActorRebound;

impl Frame<'_> {
    /// Advance only this original frame after the installed App tuple accepts
    /// the native writer's own actor receipt.
    pub(in crate::installing_broker::resource_actor) fn accept_actor_rebind(
        &mut self,
        before: &Arc<ValidatedWorkerSnapshot>,
        after: &Arc<ValidatedWorkerSnapshot>,
        actor: &ActorRebound,
    ) -> Result<()> {
        need(
            self.snapshot
                .as_ref()
                .is_some_and(|snapshot| Arc::ptr_eq(snapshot, before))
                && Arc::ptr_eq(after, &self.broker.configuration()?)
                && before.source_path() == after.source_path(),
            "RESOURCE_ACTOR_CONFIGURATION_CHANGED",
        )?;
        let context = self
            .context
            .as_ref()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_NOT_BOUND"))?
            .with_applied_configuration(after.configuration().clone());
        let bindings = self
            .bindings
            .as_mut()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_NOT_BOUND"))?;
        bindings.installed = self.private.accept_configuration_rebind(actor)?;
        ResourceActorSettings::capture(after.configuration())?
            .require_document(&bindings.installed)?;
        self.context = Some(context);
        self.snapshot = Some(Arc::clone(after));
        Ok(())
    }
}

impl Frame<'_> {
    pub(in crate::installing_broker::resource_actor) fn guard_pool_publication_peer(
        &mut self,
        proof: &PublishedPool,
        actor: &ActorRebound,
        end: Instant,
    ) -> Result<()> {
        self.assert_pool_publication_metadata(proof, actor, end)?;
        self.guard_peer_observations(end)?;
        self.assert_pool_publication_metadata(proof, actor, end)
    }
    fn assert_pool_publication_metadata(
        &self,
        proof: &PublishedPool,
        actor: &ActorRebound,
        end: Instant,
    ) -> Result<()> {
        proof.assert_live()?;
        let original = self.assert_configuration_owner(end)?;
        let (before, after, _) = proof.parts();
        need(
            Arc::ptr_eq(original, before) && before.source_path() == after.source_path(),
            "POOL_MIGRATION_PUBLICATION_CHANGED",
        )?;
        self.private
            .assert_configuration_rebind(actor, after.configuration())?;
        proof.assert_live()?;
        Ok(())
    }
}
