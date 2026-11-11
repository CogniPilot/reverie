//! The actual consuming installation owner stays outside the broker Arc.
use super::*;
impl InstallingBroker {
    pub(in crate::installing_broker) fn prepare_service_with_offer(
        self: &Arc<Self>,
        offer: BrokerInstallationOffer,
    ) -> Result<BrokerServiceStartup, Box<BrokerStartupFailure>> {
        self.prepare_owned_service(StartupMode::Offer(Box::new(offer)))
    }
}
impl StartupOwner {
    pub(super) fn assert_installation_offer_broker(&mut self) -> Result<(), BrokerStartupCause> {
        self.installation_offer.as_mut().map_or(Ok(()), |offer| {
            offer
                .assert_startup_broker(&self.broker)
                .map_err(|cause| BrokerStartupCause::InstallationOffer(Box::new(cause)))
        })
    }
    pub(super) fn assert_installation_offer(&mut self) -> Result<(), BrokerStartupCause> {
        self.installation_offer.as_mut().map_or(Ok(()), |offer| {
            offer
                .assert_startup_current(&self.broker)
                .map_err(|cause| BrokerStartupCause::InstallationOffer(Box::new(cause)))
        })
    }
}

impl StartupOwner {
    pub(super) fn close_installation_origin_metadata(
        &mut self,
    ) -> Result<(), reverie_host::worker_pool::PoolError> {
        self.installation_offer.as_ref().map_or(
            Ok(()),
            super::super::installation_offer::SharedInstallationOffer::close_origin_metadata,
        )
    }
}
impl BrokerStartupFailure {
    /// Close only this SAME retained offer's actual origin/publication owners.
    /// The primary startup cause and whole broker/offer remain retained;
    /// returned secondary causes do not become a service/global close receipt.
    pub fn close_installation_origin_metadata(
        &mut self,
    ) -> Result<(), reverie_host::worker_pool::PoolError> {
        self.owner.close_installation_origin_metadata()
    }
}
