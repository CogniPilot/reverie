//! SAME B/offer/nonce owner. View is non-consuming; only fresh explicit
//! nominated consent can latch the OS installation's irreversible attempt.
use super::*;
use reverie_contracts::resource_actor::{
    CurrentPoolInstallationConsent, CurrentPoolInstallationViewer,
    PoolInstallationConsentRequest, PoolInstallationViewRequest,
};
use std::time::{SystemTime, UNIX_EPOCH};

pub(in crate::installing_broker) struct ConsentedPoolInstallation<'a> {
    broker: &'a Arc<InstallingBroker>,
    website: Box<InstalledPoolRegistrationWebsite<'a>>,
    pin: PoolRegistrationPin,
    offer: Option<RegistrationOfferGuard<'a>>,
    request: PoolInstallationConsentRequest,
    current: CurrentPoolInstallationConsent,
    deadline: Instant,
    checks: u16,
    activation: Activation,
    failed: bool,
    activation_cleanup: Option<reverie_host::worker_pool::PoolError>,
    channel_cleanup: Option<ResourceActorError>,
}
enum Activation {
    NotStarted,
    Activating,
    Active(reverie_host::worker_pool::ActivatedController),
    Failed(Box<crate::installing_broker::pool_controller::BrokerControllerActivationFailure>),
    Rejected(Box<crate::installing_broker::ControllerInstallFailure>),
    Installed,
}
fn epoch_ms() -> Result<u64> {
    SystemTime::now().duration_since(UNIX_EPOCH).ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .filter(|value| *value <= reverie_core::revision::JS_SAFE_MAX)
        .ok_or(ResourceActorError::Refused("POOL_INSTALLATION_CLOCK_UNAVAILABLE"))
}
fn expiry(expires: u64) -> Result<()> {
    let now = epoch_ms()?;
    need(expires > now && expires - now <= 300_000, "POOL_INSTALLATION_OWNER_EXPIRED")
}
fn receive_when_ready(frame: &mut Frame<'_>, pin: &PoolRegistrationPin, end: Instant) -> std::result::Result<HumanFrame, Cause> {
    loop {
        frame.guard_peer(end).map_err(Cause::Website)?; pin.assert_current().map_err(Cause::Pin)?;
        if frame.channel().map_err(Cause::Website)?.pool_registration_frame_ready(end).map_err(ResourceActorError::from).map_err(Cause::Website)? {
            return frame.receive(end.min(Instant::now() + Duration::from_secs(5))).map_err(Cause::Website);
        }
    }
}
impl<'a> PoolRegistrationFailure<'a> {
    pub(super) fn run_consent(&mut self, broker: &'a Arc<InstallingBroker>) -> std::result::Result<(), Cause> {
        let Owner::Joined { website, pin: Some(pin) } = &mut self.owner else {
            return Err(Cause::Refused("POOL_REGISTRATION_NATIVE_OWNER_REQUIRED"));
        };
        let offer = self.offer.as_mut().ok_or(Cause::Refused("POOL_INSTALLATION_OFFER_REQUIRED"))?;
        let request = receive_when_ready(&mut website.frame, pin, self.deadline)?;
        let view_request = PoolInstallationViewRequest::decode(&request).map_err(ResourceActorError::from).map_err(Cause::Website)?;
        let view = offer.bind_view(view_request).map_err(Cause::Offer)?;
        let now = epoch_ms().map_err(Cause::Website)?;
        let remaining = u64::try_from(self.deadline.saturating_duration_since(Instant::now()).as_millis())
            .map_err(|_| Cause::Refused("POOL_INSTALLATION_CLOCK_UNAVAILABLE"))?;
        let expires = now.checked_add(remaining).ok_or(Cause::Refused("POOL_INSTALLATION_CLOCK_UNAVAILABLE"))?;
        let first = offer.offer_frame(&view, expires, false).map_err(Cause::Website)?;
        website.frame.send(&first, self.deadline).map_err(Cause::Website)?;
        let nonce = reverie_host::resource_facts::fresh_owner_nonce().map_err(ResourceActorError::from).map_err(Cause::Website)?;
        website.frame.send(&view.owner_challenge(&nonce).map_err(ResourceActorError::from).map_err(Cause::Website)?, self.deadline).map_err(Cause::Website)?;
        let answer = receive_when_ready(&mut website.frame, pin, self.deadline)?;
        let viewer: CurrentPoolInstallationViewer = view.parse_owner_reply(&answer, &nonce).map_err(ResourceActorError::from).map_err(Cause::Website)?;
        expiry(viewer.expires_at_epoch_ms()).map_err(Cause::Website)?;
        need(viewer.expires_at_epoch_ms() <= expires, "POOL_INSTALLATION_VIEW_EXPIRY_CHANGED").map_err(Cause::Website)?;
        offer.assert_current(broker).map_err(Cause::Offer)?;
        website.assert_current().map_err(Cause::Website)?;
        pin.assert_current().map_err(Cause::Pin)?;
        let confirmed = offer.offer_frame(&view, expires, true).map_err(Cause::Website)?;
        website.frame.send(&confirmed, self.deadline).map_err(Cause::Website)?;
        // Browser think-time stays on this SAME original B channel. No claim,
        // new connection, timeout reset or implicit consent occurs here.
        let selected = receive_when_ready(&mut website.frame, pin, self.deadline)?;
        let request = view.consent_request(&selected).map_err(ResourceActorError::from).map_err(Cause::Website)?;
        let nonce = reverie_host::resource_facts::fresh_owner_nonce().map_err(ResourceActorError::from).map_err(Cause::Website)?;
        website.frame.send(&request.owner_challenge(&nonce).map_err(ResourceActorError::from).map_err(Cause::Website)?, self.deadline).map_err(Cause::Website)?;
        let answer = receive_when_ready(&mut website.frame, pin, self.deadline)?;
        let current = request.parse_owner_reply(&answer, &nonce).map_err(ResourceActorError::from).map_err(Cause::Website)?;
        expiry(current.expires_at_epoch_ms()).map_err(Cause::Website)?;
        need(current.principal() == viewer.principal() && current.expires_at_epoch_ms() <= viewer.expires_at_epoch_ms(), "POOL_INSTALLATION_CONSENT_VIEW_CHANGED").map_err(Cause::Website)?;
        offer.assert_current(broker).map_err(Cause::Offer)?;
        website.assert_current().map_err(Cause::Website)?;
        pin.assert_current().map_err(Cause::Pin)?;
        offer.latch_consent(&request, &current).map_err(Cause::Offer)?;
        // Move ALL original native/channel/offer owners before any activation.
        let Owner::Joined { website, pin: Some(pin) } = std::mem::replace(&mut self.owner, Owner::Moving) else { unreachable!() };
        self.owner = Owner::Consented(Box::new(ConsentedPoolInstallation {
            broker, website, pin, offer: self.offer.take(), request, current, deadline: self.deadline, checks: 0, activation: Activation::NotStarted,
            failed: false, activation_cleanup: None, channel_cleanup: None,
        }));
        let Owner::Consented(owner) = &mut self.owner else { unreachable!() };
        owner.activate_and_publish()
    }
}
impl ConsentedPoolInstallation<'_> {
    fn activate_and_publish(&mut self) -> std::result::Result<(), Cause> {
        self.assert_current()?;
        let offer = self.offer.as_mut().ok_or(Cause::Refused("POOL_INSTALLATION_OFFER_REQUIRED"))?;
        let reserve = offer.configured_host_reserve().map_err(Cause::Offer)?;
        let origin = offer.take_activation_source().map_err(Cause::Offer)?;
        self.activation = Activation::Activating;
        match origin.activate_controller(reserve, self.deadline) {
            Ok(owner) => self.activation = Activation::Active(owner),
            Err(owner) => {
                self.activation = Activation::Failed(owner);
                return Err(Cause::Refused("POOL_CONTROLLER_ACTIVATION_RETAINED"));
            }
        }
        let Activation::Active(active) = &mut self.activation else { unreachable!() };
        active.assert_current(&self.broker.storage.runtime, self.deadline).map_err(Cause::Controller)?;
        let observed = serde_json::to_vec(&active.status_data()).map_err(|_| Cause::Refused("POOL_CONTROLLER_OBSERVATION_INVALID"))?;
        let Activation::Active(owner) = std::mem::replace(&mut self.activation, Activation::Activating) else { unreachable!() };
        match self.broker.install_activated_controller(owner) {
            Ok(()) => self.activation = Activation::Installed,
            Err(owner) => {
                self.activation = Activation::Rejected(owner);
                return Err(Cause::Refused("POOL_CONTROLLER_SLOT_RETAINED"));
            }
        }
        // Actual Host custody was moved, not reconstructed from response DATA.
        // No worker configuration/member/capacity permission follows this move.
        self.assert_current()?;
        let reply = self.request.configured_reply(&observed).map_err(ResourceActorError::from).map_err(Cause::Website)?;
        self.website.frame.send(&reply, self.deadline).map_err(Cause::Website)
    }
    pub(in crate::installing_broker) fn assert_for_broker(&mut self, broker: &InstallingBroker) -> std::result::Result<(), Cause> {
        need(std::ptr::eq(self.website.frame.broker, broker), "POOL_INSTALLATION_FOREIGN_BROKER").map_err(Cause::Website)?;
        self.assert_current()
    }
    pub(in crate::installing_broker) fn assert_live(&self, broker: &InstallingBroker) -> std::result::Result<(), Cause> {
        need(!self.failed && std::ptr::eq(self.website.frame.broker, broker), "POOL_INSTALLATION_FOREIGN_BROKER").map_err(Cause::Website)?;
        expiry(self.current.expires_at_epoch_ms()).map_err(Cause::Website)?;
        self.website.frame.guard_peer(self.deadline).map_err(Cause::Website)?;
        self.pin.assert_current().map_err(Cause::Pin)
    }
    fn assert_current(&mut self) -> std::result::Result<(), Cause> {
        if self.failed { return Err(Cause::Refused("POOL_INSTALLATION_OWNER_RETAINED")); }
        let result = self.current(); self.failed |= result.is_err(); result
    }
    fn current(&mut self) -> std::result::Result<(), Cause> {
        self.checks += 1;
        need(self.checks <= 256, "POOL_INSTALLATION_CHALLENGE_BOUND").map_err(Cause::Website)?;
        expiry(self.current.expires_at_epoch_ms()).map_err(Cause::Website)?;
        if matches!(self.activation, Activation::Installed) {
            self.broker.assert_installed_controller_current(self.deadline).map_err(Cause::Controller)?;
        } else {
            self.offer.as_mut().ok_or(Cause::Refused("POOL_INSTALLATION_OFFER_REQUIRED"))?.assert_current(self.broker).map_err(Cause::Offer)?;
        }
        self.website.assert_current().map_err(Cause::Website)?;
        self.pin.assert_current().map_err(Cause::Pin)?;
        let nonce = reverie_host::resource_facts::fresh_owner_nonce().map_err(ResourceActorError::from).map_err(Cause::Website)?;
        self.website.frame.send(&self.request.owner_challenge(&nonce).map_err(ResourceActorError::from).map_err(Cause::Website)?, self.deadline).map_err(Cause::Website)?;
        let reply = receive_when_ready(&mut self.website.frame, &self.pin, self.deadline)?;
        let current = self.request.parse_owner_reply(&reply, &nonce).map_err(ResourceActorError::from).map_err(Cause::Website)?;
        expiry(current.expires_at_epoch_ms()).map_err(Cause::Website)?;
        need(current == self.current, "POOL_INSTALLATION_CURRENT_OWNER_CHANGED").map_err(Cause::Website)?;
        self.website.assert_current().map_err(Cause::Website)?; self.pin.assert_current().map_err(Cause::Pin)?;
        Ok(())
    }
    pub(super) fn close_identity(&self) -> Option<Arc<()>> { self.offer.as_ref().map(RegistrationOfferGuard::close_identity) }
    pub(super) fn channel_closed(&mut self, closed: &PoolRegistrationComponentClosed) {
        if let Some(offer) = self.offer.as_mut() { offer.channel_closed(closed).expect("same original close identity"); }
    }
    pub(super) fn close_for_worker(&mut self, end: Instant) -> Result<WorkerLaunchClose> {
        match &mut self.activation {
            Activation::NotStarted | Activation::Installed => {},
            Activation::Failed(owner) => {
                if let Err(error) = owner.close_components(end) { self.activation_cleanup.get_or_insert(error); }
                self.disconnect_retaining();
                return Err(ResourceActorError::Refused("POOL_CONTROLLER_ACTIVATION_RETAINED"));
            }
            Activation::Rejected(owner) => {
                if let Err(error) = owner.close_components(end) { self.activation_cleanup.get_or_insert(error); }
                self.disconnect_retaining();
                return Err(ResourceActorError::Refused("POOL_CONTROLLER_SLOT_RETAINED"));
            }
            Activation::Active(_) | Activation::Activating => {
                self.disconnect_retaining();
                return Err(ResourceActorError::Refused("POOL_CONTROLLER_TRANSFER_RETAINED"));
            }
        }
        self.website.close_channel_component(end)
    }
    fn disconnect_retaining(&mut self) {
        if let Transport::Retained(channel) = &mut self.website.frame.transport {
            if let Err(error) = channel.disconnect_for_worker() { self.channel_cleanup.get_or_insert(error.into()); }
        }
    }
}
