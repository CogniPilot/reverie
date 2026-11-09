//! References to ONE actual offer, outside InstallingBroker. This is neither
//! an offer registry nor an administration/capacity capability.
use super::*;
use std::sync::{Mutex, MutexGuard};
mod preparation;
pub use preparation::{OfferPreparationView, UnpreparedOfferBinding};
#[cfg(test)]
mod tests;

#[derive(Clone)]
pub(in crate::installing_broker) struct SharedInstallationOffer {
    owner: Arc<Mutex<BrokerInstallationOffer>>,
}
pub(in crate::installing_broker) struct RegistrationOfferGuard<'a> {
    owner: MutexGuard<'a, BrokerInstallationOffer>,
    identity: Arc<()>,
    channel_closed: bool,
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
        owner.assert_current()?;
        Ok(RegistrationOfferGuard {
            owner,
            identity: Arc::new(()),
            channel_closed: false,
        })
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
    pub(in crate::installing_broker) fn configured_host_reserve(
        &self,
    ) -> Result<u32, BrokerInstallationOfferCause> {
        self.owner.check_time()?;
        let snapshot =
            self.owner
                .snapshot
                .as_ref()
                .ok_or(BrokerInstallationOfferCause::Refused(
                    "POOL_INSTALLATION_SNAPSHOT_REQUIRED",
                ))?;
        reverie_contracts::worker_validation::WorkerValidationData::new(snapshot.configuration())
            .reservation()
            .map_err(|_| {
                BrokerInstallationOfferCause::Refused("POOL_INSTALLATION_RESERVE_POLICY_INVALID")
            })?
            .map(|option| option.host_reserve_mib())
            .ok_or(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_RESERVE_POLICY_REQUIRED",
            ))
    }
    pub(in crate::installing_broker) fn take_activation_source(
        &mut self,
    ) -> Result<BrokerControllerBootstrap, BrokerInstallationOfferCause> {
        if !self.owner.registration_attempted {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_CONSENT_REQUIRED",
            ));
        }
        self.owner.check_time()?;
        match std::mem::replace(&mut self.owner.origin, Origin::Transferred) {
            Origin::Retained(owner) => Ok(*owner),
            other => {
                self.owner.origin = other;
                Err(BrokerInstallationOfferCause::Refused(
                    "POOL_INSTALLATION_ACTIVATION_SOURCE_REQUIRED",
                ))
            }
        }
    }
    pub(in crate::installing_broker) fn close_identity(&self) -> Arc<()> {
        Arc::clone(&self.identity)
    }
    pub(in crate::installing_broker) fn channel_closed(
        &mut self,
        closed: &crate::installing_broker::resource_actor::PoolRegistrationComponentClosed,
    ) -> Result<(), BrokerInstallationOfferCause> {
        if !closed.matches_offer(&self.identity) {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_REGISTRATION_FOREIGN_CLOSE",
            ));
        }
        self.channel_closed = true;
        Ok(())
    }
    pub(in crate::installing_broker) fn bind_view(
        &self,
        request: reverie_contracts::resource_actor::PoolInstallationViewRequest,
    ) -> Result<
        reverie_contracts::resource_actor::PoolInstallationOfferViewData,
        BrokerInstallationOfferCause,
    > {
        self.owner.check_time()?;
        let nonce = self
            .owner
            .nonce
            .as_ref()
            .ok_or(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_NONCE_REQUIRED",
            ))?;
        Ok(request.bind_offer_data(&self.owner.request, nonce))
    }
    pub(in crate::installing_broker) fn offer_frame(
        &self,
        view: &reverie_contracts::resource_actor::PoolInstallationOfferViewData,
        expires: u64,
        confirmed: bool,
    ) -> Result<
        reverie_contracts::human_protocol::HumanFrame,
        crate::installing_broker::resource_actor::ResourceActorError,
    > {
        if confirmed {
            view.viewed_reply(self.owner.request.policy(), expires)
        } else {
            view.offer_reply(self.owner.request.policy(), expires)
        }
        .map_err(Into::into)
    }
    /// Latches correlation only. Only the actual private B consent owner can
    /// authorize activation; decoded fields alone never provide that owner.
    pub(in crate::installing_broker) fn latch_consent(
        &mut self,
        request: &reverie_contracts::resource_actor::PoolInstallationConsentRequest,
        current: &reverie_contracts::resource_actor::CurrentPoolInstallationConsent,
    ) -> Result<(), BrokerInstallationOfferCause> {
        self.owner.check_time()?;
        if self.owner.registration_attempted
            || self.owner.nonce.as_ref() != Some(request.offer_nonce())
            || self.owner.request.digest() != request.request_digest()
            || self.owner.request.principal() != request.principal()
            || current.principal() != request.principal()
        {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_CONSENT_OFFER_CHANGED",
            ));
        }
        self.owner.registration_attempted = true;
        Ok(())
    }
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
impl Drop for RegistrationOfferGuard<'_> {
    fn drop(&mut self) {
        // Only a genuine same-guard checked channel receipt permits re-view.
        // Unwind/unknown cleanup never releases an unclaimed attempt silently.
        if !self.channel_closed {
            self.owner.failed = true;
        }
    }
}
