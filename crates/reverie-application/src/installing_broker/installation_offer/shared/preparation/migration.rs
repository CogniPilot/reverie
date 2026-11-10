//! Exact original offer identity and purpose-specific source transfer. This
//! never latches B registration consent or reconstructs a native bootstrap.
use super::*;
use crate::installing_broker::resource_actor::PoolMigrationSourceAuthorization;

pub(in crate::installing_broker) struct MigrationOfferIdentity {
    offer: SharedInstallationOffer,
}
impl MigrationOfferIdentity {
    pub(super) fn capture(view: &OfferPreparationView) -> Self {
        Self {
            offer: view.offer.clone(),
        }
    }
    pub(in crate::installing_broker) fn matches(&self, view: &OfferPreparationView) -> bool {
        Arc::ptr_eq(&self.offer.owner, &view.offer.owner)
    }
}
impl OfferPreparationView {
    pub(super) fn take_migration_source(
        &mut self,
        authorization: &PoolMigrationSourceAuthorization<'_>,
    ) -> Result<(BrokerControllerBootstrap, u32), BrokerInstallationOfferCause> {
        authorization.assert_view(self)?;
        let mut owner = self.offer.try_owner()?;
        owner.check_time()?;
        self.assert_binding(&owner)?;
        owner.current()?;
        let snapshot = owner
            .snapshot
            .as_ref()
            .ok_or(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_SNAPSHOT_REQUIRED",
            ))?;
        let reserve = reverie_contracts::worker_validation::WorkerValidationData::new(
            snapshot.configuration(),
        )
        .reservation()
        .map_err(|_| {
            BrokerInstallationOfferCause::Refused("POOL_INSTALLATION_RESERVE_POLICY_INVALID")
        })?
        .ok_or(BrokerInstallationOfferCause::Refused(
            "POOL_INSTALLATION_RESERVE_POLICY_REQUIRED",
        ))?
        .host_reserve_mib();
        authorization.assert_live()?;
        match std::mem::replace(&mut owner.origin, Origin::Transferred) {
            Origin::Retained(source) => Ok((*source, reserve)),
            original => {
                owner.origin = original;
                Err(BrokerInstallationOfferCause::Refused(
                    "POOL_MIGRATION_ACTIVATION_SOURCE_REQUIRED",
                ))
            }
        }
    }
    pub(super) fn assert_migration_transferred(&self) -> Result<(), BrokerInstallationOfferCause> {
        let owner = self.offer.try_owner()?;
        owner.check_time()?;
        self.assert_binding(&owner)?;
        if !matches!(owner.origin, Origin::Transferred) {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_MIGRATION_SOURCE_NOT_TRANSFERRED",
            ));
        }
        Ok(())
    }
}
