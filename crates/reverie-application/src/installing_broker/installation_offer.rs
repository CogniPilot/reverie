//! Consuming OS-installation prefix. The whole actual broker moves here before
//! the first origin observation or publication effect. This is not consent,
//! HostPoolAdministration, provider maintenance, capacity or fleet readiness.
use super::*;
use reverie_contracts::{
    resource_actor::PoolInstallationRequestData, worker_pool::WorkerPoolPolicy,
};
use reverie_core::operations::JournalId;
use reverie_host::worker_pool::PublishedControllerBirthData;
use std::time::{Duration, Instant};
mod error;
mod os_source;
pub use os_source::OsPoolInstallationFailure;
mod shared;
pub(in crate::installing_broker) use shared::MigrationOfferIdentity;
pub use shared::{
    ObservedOfferTarget, OfferPreparationView, OfferTargetObservationError,
    OfferTargetObservationFailure, UnpreparedOfferBinding,
};
pub(in crate::installing_broker) use shared::{RegistrationOfferGuard, SharedInstallationOffer};
#[cfg(test)]
pub(in crate::installing_broker) mod tests;

enum Origin {
    Unopened,
    Retained(Box<BrokerControllerBootstrap>),
    Failed(Box<BrokerControllerBootstrapFailure>),
    Transferred,
}
#[must_use = "retain the original broker, nominated request and publication"]
pub struct BrokerInstallationOffer {
    broker: Arc<InstallingBroker>,
    snapshot: Option<Arc<ValidatedWorkerSnapshot>>,
    request: PoolInstallationRequestData,
    origin: Origin,
    nonce: Option<JournalId>,
    published: Option<PublishedControllerBirthData>,
    deadline: Instant,
    failed: bool,
    metadata_closed: bool,
    service_closed: bool,
    registration_attempted: bool,
}
#[must_use = "failed installation keeps the whole original attempt"]
pub struct BrokerInstallationOfferFailure {
    owner: BrokerInstallationOffer,
    cause: BrokerInstallationOfferCause,
}
pub enum BrokerInstallationOfferCause {
    Configuration(GateError),
    Origin(BrokerControllerBootstrapCause),
    NativeOrigin,
    Random(reverie_host::resource_facts::ResourceFactsError),
    Refused(&'static str),
}
impl InstallingBroker {
    /// Explicit OS action only. Consuming the original broker prevents a
    /// concurrent startup or duplicate offer through an escaped Arc. There is
    /// deliberately no Arc getter or constructor from identifiers/JSON.
    pub fn prepare_pool_installation_offer(
        self,
        request: PoolInstallationRequestData,
        end: Instant,
    ) -> Result<BrokerInstallationOffer, Box<BrokerInstallationOfferFailure>> {
        let mut owner = BrokerInstallationOffer::unopened(self, request, end);
        match owner.prepare() {
            Ok(()) => Ok(owner),
            Err(cause) => {
                owner.failed = true;
                Err(Box::new(BrokerInstallationOfferFailure { owner, cause }))
            }
        }
    }
}
impl BrokerInstallationOffer {
    fn unopened(
        broker: InstallingBroker,
        request: PoolInstallationRequestData,
        end: Instant,
    ) -> Self {
        Self {
            broker: Arc::new(broker),
            snapshot: None,
            request,
            origin: Origin::Unopened,
            nonce: None,
            published: None,
            deadline: end.min(Instant::now() + Duration::from_secs(300)),
            failed: false,
            metadata_closed: false,
            service_closed: false,
            registration_attempted: false,
        }
    }
    /// Consuming entry from the actual OS-installation attempt. The only Arc
    /// used by service startup is this offer's original private broker Arc.
    /// No broker getter, fresh constructor or installation grant is exposed.
    pub fn prepare_service(self) -> Result<BrokerServiceStartup, Box<BrokerStartupFailure>> {
        let broker = Arc::clone(&self.broker);
        broker.prepare_service_with_offer(self)
    }
    pub(super) fn assert_startup_broker(
        &mut self,
        broker: &Arc<InstallingBroker>,
    ) -> Result<(), BrokerInstallationOfferCause> {
        if !Arc::ptr_eq(&self.broker, broker) {
            self.failed = true;
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_FOREIGN_BROKER",
            ));
        }
        self.check_time()
    }
    pub(super) fn assert_startup_current(
        &mut self,
        broker: &Arc<InstallingBroker>,
    ) -> Result<(), BrokerInstallationOfferCause> {
        self.assert_startup_broker(broker)?;
        // Uses the original deadline/snapshot/origin/publication throughout.
        // It cannot renew the attempt or reconstruct its authority from data.
        self.assert_current()
    }
    pub(super) fn close_after_service(
        &mut self,
        closed: &service::ClosedBrokerResources<'_>,
    ) -> Result<(), reverie_host::worker_pool::PoolError> {
        if !closed.same_broker(&self.broker) {
            return Err(reverie_host::worker_pool::PoolError::Refused(
                "POOL_INSTALLATION_OFFER_FOREIGN_SERVICE_CLOSE",
            ));
        }
        // This closes the SAME origin/publication even after the offer's
        // installation deadline, without authorizing a new installation step.
        self.close_origin_metadata()?;
        self.service_closed = true;
        Ok(())
    }
    fn prepare(&mut self) -> Result<(), BrokerInstallationOfferCause> {
        self.check_time()?;
        self.snapshot = Some(
            self.broker
                .configuration()
                .map_err(BrokerInstallationOfferCause::Configuration)?,
        );
        match self
            .broker
            .retain_pool_installation_offer_bootstrap(self.deadline)
        {
            Ok(origin) => self.origin = Origin::Retained(Box::new(origin)),
            Err(failure) => {
                self.origin = Origin::Failed(failure);
                return Err(BrokerInstallationOfferCause::NativeOrigin);
            }
        }
        self.assert_origin()?;
        self.nonce = Some(
            reverie_host::resource_facts::fresh_owner_nonce()
                .map_err(BrokerInstallationOfferCause::Random)?,
        );
        let policy = self.request.policy().clone();
        self.publish(policy)?;
        self.assert_current()
    }
    fn publish(&mut self, policy: WorkerPoolPolicy) -> Result<(), BrokerInstallationOfferCause> {
        let Origin::Retained(origin) = &mut self.origin else {
            return Err(BrokerInstallationOfferCause::NativeOrigin);
        };
        self.published = Some(
            origin
                .publish_birth_metadata(policy, self.deadline)
                .map_err(BrokerInstallationOfferCause::Origin)?,
        );
        Ok(())
    }
    fn check_time(&self) -> Result<(), BrokerInstallationOfferCause> {
        if self.failed || self.metadata_closed || Instant::now() >= self.deadline {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_EXPIRED_OR_CLOSED",
            ));
        }
        Ok(())
    }
    fn assert_origin(&mut self) -> Result<(), BrokerInstallationOfferCause> {
        self.check_time()?;
        let current = self
            .broker
            .configuration()
            .map_err(BrokerInstallationOfferCause::Configuration)?;
        if !self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| Arc::ptr_eq(snapshot, &current))
        {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_CONFIGURATION_CHANGED",
            ));
        }
        let Origin::Retained(origin) = &mut self.origin else {
            return Err(BrokerInstallationOfferCause::NativeOrigin);
        };
        origin
            .assert_current(self.deadline)
            .map_err(BrokerInstallationOfferCause::Origin)
    }
    /// Native observation only. It neither accepts consent nor emits an
    /// administration, pool or provider-fence capability.
    pub fn assert_current(&mut self) -> Result<(), BrokerInstallationOfferCause> {
        let result = self.current();
        self.failed |= result.is_err();
        result
    }
    fn current(&mut self) -> Result<(), BrokerInstallationOfferCause> {
        self.assert_origin()?;
        let Origin::Retained(origin) = &self.origin else {
            return Err(BrokerInstallationOfferCause::NativeOrigin);
        };
        if self.nonce.is_none()
            || self.published.as_ref()
                != Some(
                    &origin
                        .published_birth_reference()
                        .map_err(BrokerInstallationOfferCause::Origin)?,
                )
        {
            return Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_PUBLICATION_CHANGED",
            ));
        }
        self.assert_origin()?;
        self.check_time()
    }
    /// Terminal metadata close only. No broker/resource stop, offer replay,
    /// provider release or global shutdown acknowledgment is implied.
    pub fn close_origin_metadata(&mut self) -> Result<(), reverie_host::worker_pool::PoolError> {
        if matches!(self.origin, Origin::Transferred) {
            return Ok(());
        }
        self.metadata_closed = true;
        match &mut self.origin {
            Origin::Transferred => Ok(()),
            Origin::Unopened => Ok(()),
            Origin::Retained(origin) => origin.close_origin_metadata(),
            Origin::Failed(failure) => failure.close_origin_metadata(),
        }
    }
}
impl BrokerInstallationOfferFailure {
    pub fn cause(&self) -> &BrokerInstallationOfferCause {
        &self.cause
    }
    pub fn native_origin_cause(&self) -> Option<&BrokerControllerBootstrapCause> {
        match &self.owner.origin {
            Origin::Failed(failure) => Some(failure.cause()),
            _ => None,
        }
    }
    pub fn close_origin_metadata(&mut self) -> Result<(), reverie_host::worker_pool::PoolError> {
        self.owner.close_origin_metadata()
    }
}
impl Drop for BrokerInstallationOffer {
    fn drop(&mut self) {
        // Metadata closure alone never establishes broker/resource closure.
        // Only the private actual same-service closure witness above permits
        // release, and only after both original metadata owners closed known.
        if !self.service_closed {
            std::mem::forget(Arc::clone(&self.broker));
        }
    }
}
