//! Actual Q owner adopts only its same-claim one-shot RAM publication. No
//! caller configuration or parsed receipt can advance the expected snapshot.
use super::*;
use crate::reservation_gate::{CommittedPolicy, RetainedPreparation};
use reverie_contracts::ram_migration::RamMigrationPolicy;

impl AuthenticatedResourceOperation<'_> {
    /// Call after commit_ram_configuration returns its checked-closed receipt,
    /// outside lifecycle/admission. A fresh native/current-owner exchange
    /// follows the metadata-only adoption; any refusal poisons THIS operation.
    pub fn adopt_committed_ram_policy(
        &mut self,
        claim: &RetainedPreparation,
        policy: &RamMigrationPolicy,
        receipt: &mut CommittedPolicy,
    ) -> Result<()> {
        let adopted = self.adopt_ram_snapshot(claim, policy, receipt);
        self.website.frame.failed |= adopted.is_err();
        adopted?;
        self.assert_current()
    }
    fn adopt_ram_snapshot(
        &mut self,
        claim: &RetainedPreparation,
        policy: &RamMigrationPolicy,
        receipt: &mut CommittedPolicy,
    ) -> Result<()> {
        let frame = &mut self.website.frame;
        need(
            !frame.failed && Instant::now() < frame.deadline,
            "RESOURCE_ACTOR_CHANNEL_EXPIRED",
        )?;
        expiry(self.owner.as_ref().ok_or(ResourceActorError::Refused(
            "RESOURCE_ACTOR_OWNER_CONTEXT_REQUIRED",
        ))?)?;
        let Transport::Retained(channel) = &frame.transport else {
            return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE"));
        };
        channel.require_connected()?;
        claim.assert_ram_approval(&self.request, policy)?;
        let original = frame
            .snapshot
            .as_ref()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_NOT_BOUND"))?;
        let installed = receipt.ram_snapshot_for(frame.broker, claim, policy, original)?;
        frame
            .private
            .assert_metadata(installed.configuration(), frame.deadline)?;
        expiry(
            self.owner
                .as_ref()
                .expect("original current owner retained"),
        )?;
        channel.require_connected()?;
        // Only original context configuration DATA changes. Its original
        // native source, cancellation, origin and scoped query owner survive.
        let context = frame
            .context
            .as_ref()
            .expect("authenticated native context")
            .with_applied_configuration(installed.configuration().clone());
        frame.context = Some(context);
        frame.snapshot = Some(installed);
        Ok(())
    }
}
