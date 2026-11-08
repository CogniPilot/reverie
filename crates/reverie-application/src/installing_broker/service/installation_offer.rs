//! The actual consuming installation owner stays outside the broker Arc.
use super::*;
impl InstallingBroker {
    pub(in crate::installing_broker) fn prepare_service_with_offer(
        self: &Arc<Self>,
        offer: BrokerInstallationOffer,
    ) -> Result<BrokerServiceStartup, Box<BrokerStartupFailure>> {
        self.prepare_owned_service(Some(offer))
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
