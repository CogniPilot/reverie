//! Observation of the existing outer offer, without consuming B registration.
use super::*;

impl BrokerService {
    /// Observe only the SAME retained OS offer. Ordinary startup has no offer
    /// and returns None; this is never a prepared-target or fleet-drain grant.
    pub fn installation_offer_preparation_view(
        &self,
    ) -> Result<Option<OfferPreparationView>, BrokerInstallationOfferCause> {
        self.startup
            .owner
            .installation_offer
            .as_ref()
            .map(|offer| offer.preparation_view(&self.startup.owner.broker))
            .transpose()
    }
}
