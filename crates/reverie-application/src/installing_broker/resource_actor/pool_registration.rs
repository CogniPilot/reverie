//! Actual B/OS-offer consumer on the original registered handler stack. Native
//! attestation and a B pin do not constitute owner consent or administration.
//! The current B contract specifies only its guarded greeting, not a consent
//! or refusal frame. This cut preserves its typed continuation-required cause
//! locally, then closes the original channel; a client sees greeting then EOF,
//! never a successful installation response.
use super::*;
use crate::installing_broker::installation_offer::RegistrationOfferGuard;
use reverie_host::worker_reports::{PoolRegistrationPin, WorkerActorPinError};

enum Owner<'a> {
    Moving,
    Incoming(WorkerServiceConnection),
    Entry(Box<ResourceActorFailure<'a>>),
    Joined {
        website: InstalledPoolRegistrationWebsite<'a>,
        pin: Option<PoolRegistrationPin>,
    },
}
enum Cause {
    Offer(BrokerInstallationOfferCause),
    Website(ResourceActorError),
    Pin(WorkerActorPinError),
    Refused(&'static str),
}
impl std::fmt::Display for Cause {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Offer(cause) => cause.fmt(out),
            Self::Website(cause) => cause.fmt(out),
            Self::Pin(cause) => cause.fmt(out),
            Self::Refused(code) => out.write_str(code),
        }
    }
}
#[must_use = "retain this original B frame, pin and counted handler through checked cleanup"]
pub(in crate::installing_broker) struct PoolRegistrationFailure<'a> {
    owner: Owner<'a>,
    primary: Cause,
    first_cleanup: Option<ResourceActorError>,
    cleanup_failures: u64,
    deadline: Instant,
}
impl PoolRegistrationFailure<'_> {
    /// SAME original components only. No attestation, offer claim, consent or
    /// reply is replayed by a handler reconciliation command.
    pub(in crate::installing_broker) fn settle_for_worker(&mut self) -> bool {
        let result = match &mut self.owner {
            Owner::Moving => Err(ResourceActorError::Refused("POOL_REGISTRATION_ENTRY_STATE")),
            Owner::Incoming(connection) => connection.close_socket_for_worker().map_err(Into::into),
            Owner::Entry(owner) => owner.close_channel_component(self.deadline),
            Owner::Joined { website, .. } => website.close_channel_component(self.deadline),
        };
        match result {
            Ok(_) => true,
            Err(cause) => {
                self.first_cleanup.get_or_insert(cause);
                self.cleanup_failures = self.cleanup_failures.saturating_add(1);
                false
            }
        }
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
            primary: Cause::Offer(cause),
            first_cleanup: None,
            cleanup_failures: 0,
            deadline,
        })
    }
    pub(in crate::installing_broker) fn handle_pool_registration(
        self: &Arc<Self>,
        connection: WorkerServiceConnection,
        offer: &mut RegistrationOfferGuard<'_>,
        original_end: Instant,
    ) -> Box<PoolRegistrationFailure<'_>> {
        // Capture the original B deadline before any fallible observation and
        // retain the accepted connection in this owner before checking origin.
        let deadline = original_end.min(offer.deadline());
        let mut failure = Box::new(PoolRegistrationFailure {
            owner: Owner::Incoming(connection),
            primary: Cause::Refused("POOL_REGISTRATION_CONSENT_CONTINUATION_REQUIRED"),
            first_cleanup: None,
            cleanup_failures: 0,
            deadline,
        });
        if let Err(cause) = failure.prepare(self, offer) {
            failure.primary = cause;
        }
        failure
    }
}
impl<'a> PoolRegistrationFailure<'a> {
    fn prepare(
        &mut self,
        broker: &'a Arc<InstallingBroker>,
        offer: &mut RegistrationOfferGuard<'_>,
    ) -> std::result::Result<(), Cause> {
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
                    website: InstalledPoolRegistrationWebsite { frame },
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
        offer.assert_current(broker).map_err(Cause::Offer)
    }
}
