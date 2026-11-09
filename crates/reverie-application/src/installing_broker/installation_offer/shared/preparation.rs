//! Non-consuming references to the SAME outer OS offer. A view owns no new
//! native scope; dropping it only releases its reference, never the B attempt.
use super::*;
use reverie_core::operations::JournalDigest;

/// Original-offer observation only. It is not target preparation, consent,
/// fleet-drain permission, controller activation or a capacity capability.
#[must_use = "retain the original offer while observing its bindings"]
pub struct OfferPreparationView {
    offer: SharedInstallationOffer,
    broker: Arc<InstallingBroker>,
    snapshot: Option<Arc<ValidatedWorkerSnapshot>>,
    digest: JournalDigest,
    policy: Vec<u8>,
    nonce: Option<JournalId>,
    publication: Option<PublishedControllerBirthData>,
    deadline: Instant,
}

/// DATA observed from an actual current original offer. No prepared target or
/// installation/fleet authority can be constructed from these copied values.
#[derive(Clone)]
pub struct UnpreparedOfferBinding {
    policy: WorkerPoolPolicy,
    policy_bytes: Vec<u8>,
    request_digest: JournalDigest,
    offer_nonce: JournalId,
    publication: PublishedControllerBirthData,
    deadline: Instant,
}

impl SharedInstallationOffer {
    pub(in crate::installing_broker) fn preparation_view(
        &self,
        broker: &Arc<InstallingBroker>,
    ) -> Result<OfferPreparationView, BrokerInstallationOfferCause> {
        let owner = self.try_owner()?;
        if !Arc::ptr_eq(&owner.broker, broker) {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_FOREIGN_BROKER",
            ));
        }
        owner.check_time()?;
        if owner.registration_attempted {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_REGISTRATION_REPLAYED",
            ));
        }
        // Capturing a reference is not a successful native-origin read. Only
        // read_current below can return observed binding DATA.
        Ok(OfferPreparationView {
            offer: self.clone(),
            broker: Arc::clone(broker),
            snapshot: owner.snapshot.clone(),
            digest: owner.request.digest().clone(),
            policy: policy_bytes(&owner)?,
            nonce: owner.nonce.clone(),
            publication: owner.published.clone(),
            deadline: owner.deadline,
        })
    }
}

impl OfferPreparationView {
    /// Revalidate the captured tuple and the original native origin. Refusal
    /// never latches B consent/registration or the offer's failed flag; any
    /// native uncertainty remains inside the SAME original bootstrap owner.
    pub fn read_current(&mut self) -> Result<UnpreparedOfferBinding, BrokerInstallationOfferCause> {
        let mut owner = self.offer.try_owner()?;
        owner.check_time()?;
        self.assert_binding(&owner)?;
        owner.current()?;
        self.assert_binding(&owner)?;
        Ok(UnpreparedOfferBinding {
            policy: owner.request.policy().clone(),
            policy_bytes: self.policy.clone(),
            request_digest: self.digest.clone(),
            offer_nonce: self
                .nonce
                .clone()
                .ok_or(BrokerInstallationOfferCause::Refused(
                    "POOL_INSTALLATION_OFFER_NONCE_REQUIRED",
                ))?,
            publication: self
                .publication
                .clone()
                .ok_or(BrokerInstallationOfferCause::Refused(
                    "POOL_INSTALLATION_OFFER_PUBLICATION_CHANGED",
                ))?,
            deadline: self.deadline,
        })
    }

    fn assert_binding(
        &self,
        owner: &BrokerInstallationOffer,
    ) -> Result<(), BrokerInstallationOfferCause> {
        let snapshot_matches = match (&self.snapshot, &owner.snapshot) {
            (Some(before), Some(current)) => Arc::ptr_eq(before, current),
            (None, None) => true,
            _ => false,
        };
        if !Arc::ptr_eq(&self.broker, &owner.broker)
            || !snapshot_matches
            || owner.request.digest() != &self.digest
            || policy_bytes(owner)? != self.policy
            || owner.nonce != self.nonce
            || owner.published != self.publication
            || owner.deadline != self.deadline
            || owner.registration_attempted
        {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_PREPARATION_BINDING_CHANGED",
            ));
        }
        Ok(())
    }
}

fn policy_bytes(owner: &BrokerInstallationOffer) -> Result<Vec<u8>, BrokerInstallationOfferCause> {
    serde_json::to_vec(owner.request.policy())
        .map_err(|_| BrokerInstallationOfferCause::Refused("POOL_INSTALLATION_POLICY_ENCODING"))
}

impl UnpreparedOfferBinding {
    pub fn policy(&self) -> &WorkerPoolPolicy {
        &self.policy
    }
    pub fn policy_bytes(&self) -> &[u8] {
        &self.policy_bytes
    }
    pub fn request_digest(&self) -> &JournalDigest {
        &self.request_digest
    }
    pub fn offer_nonce(&self) -> &JournalId {
        &self.offer_nonce
    }
    pub fn publication(&self) -> &PublishedControllerBirthData {
        &self.publication
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }
}
