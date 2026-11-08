//! Actual B/OS-offer consumer on the original registered handler stack. Native
//! attestation and a B pin do not constitute owner consent or administration.
//! The current B contract specifies only its guarded greeting, not a consent
//! or refusal frame. This cut preserves its typed continuation-required cause
//! locally, then closes the original channel; a client sees greeting then EOF,
//! never a successful installation response.
use super::*;
use crate::installing_broker::installation_offer::RegistrationOfferGuard;
use reverie_host::worker_reports::{PoolRegistrationPin, WorkerActorPinError};
mod consent;
#[cfg(test)]
mod tests;

enum Owner<'a> {
    Moving,
    Incoming(WorkerServiceConnection),
    Entry(Box<ResourceActorFailure<'a>>),
    Joined {
        website: Box<InstalledPoolRegistrationWebsite<'a>>,
        pin: Option<PoolRegistrationPin>,
    },
    Consented(Box<consent::ConsentedPoolInstallation<'a>>),
}
impl Owner<'_> {
    fn close_identity(&self) -> Option<Arc<()>> {
        match self {
            Self::Consented(owner) => owner.close_identity(),
            _ => None,
        }
    }
    fn channel_closed(&mut self, closed: &PoolRegistrationComponentClosed) {
        if let Self::Consented(owner) = self {
            owner.channel_closed(closed);
        }
    }
    fn into_entry_primary(self) -> Option<ResourceActorError> {
        match self {
            Self::Entry(owner) => Some(owner.cause),
            _ => None,
        }
    }
}
pub(in crate::installing_broker) enum Cause {
    ControllerInstalled,
    Offer(BrokerInstallationOfferCause),
    Website(ResourceActorError),
    Pin(WorkerActorPinError),
    Controller(reverie_host::worker_pool::PoolError),
    Refused(&'static str),
}
impl std::fmt::Display for Cause {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ControllerInstalled => out.write_str("POOL_CONTROLLER_INSTALLED"),
            Self::Offer(cause) => cause.fmt(out),
            Self::Website(cause) => cause.fmt(out),
            Self::Pin(cause) => cause.fmt(out),
            Self::Controller(cause) => cause.fmt(out),
            Self::Refused(code) => out.write_str(code),
        }
    }
}
#[must_use = "retain this original B frame, pin and counted handler through checked cleanup"]
pub(in crate::installing_broker) struct PoolRegistrationFailure<'a> {
    owner: Owner<'a>,
    offer: Option<RegistrationOfferGuard<'a>>,
    primary: Cause,
    first_cleanup: Option<ResourceActorError>,
    cleanup_failures: u64,
    deadline: Instant,
}
/// Original channel component only, never consent, an offer release, joined
/// handler, native resource closure or administration/capacity authority.
pub(in crate::installing_broker) struct PoolRegistrationComponentClosed {
    primary: Cause,
    entry_primary: Option<ResourceActorError>,
    first_cleanup: Option<ResourceActorError>,
    offer_identity: Option<Arc<()>>,
}
impl PoolRegistrationComponentClosed {
    pub(in crate::installing_broker) fn matches_offer(&self, identity: &Arc<()>) -> bool {
        self.offer_identity.as_ref().is_some_and(|actual| Arc::ptr_eq(actual, identity))
    }
}
impl PoolRegistrationFailure<'_> {
    /// SAME original components only. No attestation, offer claim, consent or
    /// reply is replayed by a handler reconciliation command.
    pub(in crate::installing_broker) fn settle_for_worker(
        mut self: Box<Self>,
    ) -> std::result::Result<PoolRegistrationComponentClosed, Box<Self>> {
        let result = match &mut self.owner {
            Owner::Moving => Err(ResourceActorError::Refused("POOL_REGISTRATION_ENTRY_STATE")),
            Owner::Incoming(connection) => connection.close_socket_for_worker().map_err(Into::into),
            Owner::Entry(owner) => owner.close_channel_component(self.deadline),
            Owner::Joined { website, .. } => website.close_channel_component(self.deadline),
            Owner::Consented(owner) => owner.close_for_worker(self.deadline),
        };
        let result = match result {
            Ok(WorkerLaunchClose::Complete | WorkerLaunchClose::SocketClosedHandlerRetained) => {
                Ok(())
            }
            Ok(WorkerLaunchClose::SocketClosedLifecycleHeld) => Err(ResourceActorError::Refused(
                "POOL_REGISTRATION_LIFECYCLE_HELD",
            )),
            Err(cause) => Err(cause),
        };
        match result {
            Ok(()) => {
                let Self {
                    mut owner,
                    mut offer,
                    primary,
                    first_cleanup,
                    ..
                } = *self;
                // The Frame/channel owners close and drop before releasing
                // the actual offer guard; no count or Arc observation grants it.
                let mut closed = PoolRegistrationComponentClosed {
                    primary,
                    entry_primary: None,
                    first_cleanup,
                    offer_identity: offer.as_ref().map(RegistrationOfferGuard::close_identity).or_else(|| owner.close_identity()),
                };
                if let Some(offer) = offer.as_mut() {
                    // Actual known Frame/socket/Hold close above, bound to the
                    // same original guard. This is not a pool/domain release.
                    offer.channel_closed(&closed).expect("same original close identity");
                }
                owner.channel_closed(&closed);
                closed.entry_primary = owner.into_entry_primary();
                drop(offer);
                Ok(closed)
            }
            Err(cause) => {
                self.first_cleanup.get_or_insert(cause);
                self.cleanup_failures = self.cleanup_failures.saturating_add(1);
                Err(self)
            }
        }
    }
}
impl std::fmt::Display for PoolRegistrationComponentClosed {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.primary.fmt(out)?;
        if let Some(cause) = &self.entry_primary {
            write!(out, "; original entry: {cause}")?;
        }
        if let Some(cause) = &self.first_cleanup {
            write!(out, "; prior cleanup: {cause}")?;
        }
        Ok(())
    }
}
impl std::fmt::Display for PoolRegistrationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "B registration retained: {}", self.primary)?;
        if let Owner::Entry(owner) = &self.owner {
            write!(out, ": {}", owner.cause())?;
        }
        if let Some(cause) = &self.first_cleanup {
            write!(
                out,
                "; cleanup: {cause}; failed closes: {}",
                self.cleanup_failures
            )?;
        }
        Ok(())
    }
}
impl InstallingBroker {
    pub(in crate::installing_broker) fn refuse_pool_registration(
        &self,
        connection: WorkerServiceConnection,
        cause: BrokerInstallationOfferCause,
        deadline: Instant,
    ) -> Box<PoolRegistrationFailure<'_>> {
        Box::new(PoolRegistrationFailure {
            owner: Owner::Incoming(connection),
            offer: None,
            primary: Cause::Offer(cause),
            first_cleanup: None,
            cleanup_failures: 0,
            deadline,
        })
    }
    pub(in crate::installing_broker) fn handle_pool_registration<'a>(
        self: &'a Arc<Self>,
        connection: WorkerServiceConnection,
        offer: RegistrationOfferGuard<'a>,
        original_end: Instant,
    ) -> Box<PoolRegistrationFailure<'a>> {
        // Capture the original B deadline before any fallible observation and
        // retain the accepted connection in this owner before checking origin.
        let deadline = original_end.min(offer.deadline());
        let mut failure = Box::new(PoolRegistrationFailure {
            owner: Owner::Incoming(connection),
            offer: Some(offer),
            primary: Cause::Refused("POOL_REGISTRATION_CONSENT_CONTINUATION_REQUIRED"),
            first_cleanup: None,
            cleanup_failures: 0,
            deadline,
        });
        failure.primary = match failure.prepare(self) { Ok(()) => Cause::ControllerInstalled, Err(cause) => cause };
        failure
    }
}
impl<'a> PoolRegistrationFailure<'a> {
    fn prepare(&mut self, broker: &'a Arc<InstallingBroker>) -> std::result::Result<(), Cause> {
        let offer = self
            .offer
            .as_mut()
            .ok_or(Cause::Refused("POOL_INSTALLATION_OFFER_REQUIRED"))?;
        offer.assert_current(broker).map_err(Cause::Offer)?;
        let Owner::Incoming(connection) = std::mem::replace(&mut self.owner, Owner::Moving) else {
            return Err(Cause::Refused("POOL_REGISTRATION_ENTRY_STATE"));
        };
        match broker.prepare_website_frame_until(
            connection,
            WebsitePurpose::PoolRegistration,
            self.deadline,
        ) {
            Ok(frame) => {
                self.owner = Owner::Joined {
                    website: Box::new(InstalledPoolRegistrationWebsite { frame }),
                    pin: None,
                }
            }
            Err(owner) => {
                self.owner = Owner::Entry(owner);
                return Err(Cause::Refused("POOL_REGISTRATION_NATIVE_ENTRY_RETAINED"));
            }
        }
        let Owner::Joined { website, pin } = &mut self.owner else {
            unreachable!()
        };
        *pin = Some(
            website
                .frame
                .channel()
                .map_err(Cause::Website)?
                .retain_pool_registration_pin(&broker.reports)
                .map_err(Cause::Pin)?,
        );
        offer.assert_current(broker).map_err(Cause::Offer)?;
        website.assert_current().map_err(Cause::Website)?;
        pin.as_ref()
            .expect("actual B pin retained")
            .assert_current()
            .map_err(Cause::Pin)?;
        offer.assert_current(broker).map_err(Cause::Offer)?;
        self.run_consent(broker)
    }
}
