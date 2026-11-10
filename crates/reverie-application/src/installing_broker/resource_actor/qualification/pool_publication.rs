//! Exact staged publication: native actor CAS completed, while the original
//! App snapshot/controller tuple has not yet been atomically installed.
use super::*;
use crate::reservation_gate::PublishedPool;
use reverie_host::resource_facts::ActorRebound;

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
