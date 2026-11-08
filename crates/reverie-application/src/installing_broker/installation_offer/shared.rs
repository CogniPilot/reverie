//! References to ONE actual offer, outside InstallingBroker. This is neither
//! an offer registry nor an administration/capacity capability.
use super::*;
use std::sync::{Mutex, MutexGuard};
#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(in crate::installing_broker) struct SharedInstallationOffer {
    owner: Arc<Mutex<BrokerInstallationOffer>>,
}
pub(in crate::installing_broker) struct RegistrationOfferGuard<'a> {
    owner: MutexGuard<'a, BrokerInstallationOffer>,
}
impl SharedInstallationOffer {
    pub(in crate::installing_broker) fn retain(owner: BrokerInstallationOffer) -> Self {
        Self {
            owner: Arc::new(Mutex::new(owner)),
        }
    }
    fn try_owner(
        &self,
    ) -> Result<MutexGuard<'_, BrokerInstallationOffer>, BrokerInstallationOfferCause> {
        self.owner.try_lock().map_err(|_| {
            BrokerInstallationOfferCause::Refused("POOL_INSTALLATION_OFFER_BUSY_OR_POISONED")
        })
    }
    pub(in crate::installing_broker) fn assert_startup_broker(
        &self,
        broker: &Arc<InstallingBroker>,
    ) -> Result<(), BrokerInstallationOfferCause> {
        self.try_owner()?.assert_startup_broker(broker)
    }
    pub(in crate::installing_broker) fn assert_startup_current(
        &self,
        broker: &Arc<InstallingBroker>,
    ) -> Result<(), BrokerInstallationOfferCause> {
        self.try_owner()?.assert_startup_current(broker)
    }
    pub(in crate::installing_broker) fn enter_registration(
        &self,
        broker: &Arc<InstallingBroker>,
    ) -> Result<RegistrationOfferGuard<'_>, BrokerInstallationOfferCause> {
        let mut owner = self.try_owner()?;
        owner.assert_startup_broker(broker)?;
        if owner.registration_attempted {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_REGISTRATION_REPLAYED",
            ));
        }
        owner.registration_attempted = true;
        owner.assert_current()?;
        Ok(RegistrationOfferGuard { owner })
    }
    pub(in crate::installing_broker) fn close_origin_metadata(
        &self,
    ) -> Result<(), reverie_host::worker_pool::PoolError> {
        self.owner
            .try_lock()
            .map_err(|_| {
                reverie_host::worker_pool::PoolError::Refused(
                    "POOL_INSTALLATION_OFFER_BUSY_OR_POISONED",
                )
            })?
            .close_origin_metadata()
    }
    pub(in crate::installing_broker) fn close_after_service(
        &self,
        closed: &service::ClosedBrokerResources<'_>,
    ) -> Result<(), reverie_host::worker_pool::PoolError> {
        self.owner
            .try_lock()
            .map_err(|_| {
                reverie_host::worker_pool::PoolError::Refused(
                    "POOL_INSTALLATION_OFFER_BUSY_OR_POISONED",
                )
            })?
            .close_after_service(closed)
    }
}
impl RegistrationOfferGuard<'_> {
    pub(in crate::installing_broker) fn deadline(&self) -> Instant {
        self.owner.deadline
    }
    pub(in crate::installing_broker) fn assert_current(
        &mut self,
        broker: &Arc<InstallingBroker>,
    ) -> Result<(), BrokerInstallationOfferCause> {
        self.owner.assert_startup_current(broker)
    }
}
