//! Lower source-transfer authority borrows the actual retained migration
//! request and original Q fields. There is no copied-DATA constructor.
use super::*;
use crate::installing_broker::installation_offer::MigrationOfferIdentity;

pub(in crate::installing_broker) struct PoolMigrationSourceAuthorization<'a> {
    request: &'a FleetMaintenanceRequest,
    broker: &'a InstallingBroker,
    snapshot: &'a Arc<ValidatedWorkerSnapshot>,
    identity: MigrationOfferIdentity,
    binding: UnpreparedOfferBinding,
    end: Instant,
}
impl PoolMigrationSourceAuthorization<'_> {
    pub(in crate::installing_broker) fn assert_live(
        &self,
    ) -> std::result::Result<(), BrokerInstallationOfferCause> {
        let end = self
            .broker
            .storage
            .runtime
            .stop_deadline()
            .map_or(self.end, |stop| stop.min(self.end));
        if Instant::now() >= end {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_MIGRATION_AUTHORIZATION_EXPIRED",
            ));
        }
        Ok(())
    }
    pub(in crate::installing_broker) fn assert_view(
        &self,
        view: &mut OfferPreparationView,
    ) -> std::result::Result<(), BrokerInstallationOfferCause> {
        self.assert_live()?;
        if self.request.action() != FleetMaintenanceAction::MigratePool
            || !self.identity.matches(view)
        {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_MIGRATION_FOREIGN_OFFER",
            ));
        }
        view.assert_fleet_preview_binding(self.broker, self.snapshot, self.request.principal())?;
        let current = view.read_current()?;
        if current.policy_bytes() != self.binding.policy_bytes()
            || current.request_digest() != self.binding.request_digest()
            || current.offer_nonce() != self.binding.offer_nonce()
            || current.publication() != self.binding.publication()
            || current.deadline() != self.binding.deadline()
        {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_MIGRATION_OFFER_CHANGED",
            ));
        }
        Ok(())
    }
}
impl DrainedPoolMigration<'_> {
    pub(in super::super) fn take_activation_source(
        &mut self,
    ) -> Result<(BrokerControllerBootstrap, u32)> {
        let owner = self.fleet.owner.as_mut().expect("original migration fleet");
        let auth = &mut owner.authorization.owner;
        let frame = auth.frame.as_ref().expect("same Q");
        let target = auth.target.as_mut().expect("original target");
        let binding = target.current()?;
        let identity = target.migration_identity()?;
        let now = owner::epoch()?;
        let expires = auth
            .maintenance_owner
            .as_ref()
            .expect("fresh actual migration owner")
            .expires_at_epoch_ms();
        if expires <= now {
            return Err(Cause::Refused("POOL_MIGRATION_AUTHORIZATION_EXPIRED"));
        }
        let end = Instant::now()
            .checked_add(Duration::from_millis(expires - now))
            .ok_or(Cause::Refused("POOL_MIGRATION_AUTHORIZATION_EXPIRED"))?
            .min(frame.deadline);
        let authorization = PoolMigrationSourceAuthorization {
            request: auth
                .maintenance_request
                .as_ref()
                .expect("actual migration consent"),
            broker: frame.broker,
            snapshot: frame.snapshot.as_ref().expect("original snapshot"),
            identity,
            binding: binding.clone(),
            end,
        };
        target.transfer_migration_source(&authorization, binding)
    }
}
