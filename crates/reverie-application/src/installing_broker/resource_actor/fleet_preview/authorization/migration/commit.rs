//! The actual native publication proof is the ONLY staged-metadata path.
//! No old actor inode is checked after its known third CAS, and the App tuple
//! remains before until the atomic publisher consumes the original controller.
use super::*;
use crate::reservation_gate::{PublishedPool, ReservationGate};
use reverie_host::{resource_facts::ActorRebound, worker_pool::ActivatedController};

impl DrainedPoolMigration<'_> {
    pub(crate) fn assert_publication_commit_current(
        &mut self,
        gate: &ReservationGate,
        proof: &PublishedPool,
        actor: &ActorRebound,
        controller: &mut Option<ActivatedController>,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        self.assert_publication_selection(gate)?;
        let owner = self.fleet.owner.as_mut().expect("same original fleet");
        let preview = &mut owner.authorization.owner;
        if let Some(cause) = &preview.primary {
            return Err(FleetMaintenanceCheckError::retained(cause));
        }
        let body = (|| {
            preview.assert_commit_native(proof, actor)?;
            controller
                .as_mut()
                .ok_or(Cause::Refused("POOL_MIGRATION_CONTROLLER_REQUIRED"))?
                .assert_current(&owner.broker.storage.runtime, preview.original_end())
                .map_err(Cause::Pool)?;
            preview.assert_commit_native(proof, actor)
        })();
        preview.retain_check(body)
    }
}
impl NativeFleetPreview<'_> {
    fn assert_commit_native(&mut self, proof: &PublishedPool, actor: &ActorRebound) -> Result<()> {
        let end = self.original_end();
        self.frame
            .as_mut()
            .expect("same original Q")
            .guard_pool_publication_peer(proof, actor, end)?;
        self.coverage
            .as_ref()
            .expect("original company")
            .read_current_company(self.frame.as_mut().expect("same Q"))?;
        self.target
            .as_ref()
            .expect("original target")
            .assert_migration_transferred()?;
        self.assert_binding()?;
        self.assert_inputs_current()?;
        self.assert_maintenance_owner_live()?;
        proof.assert_live()?;
        Ok(())
    }
}
