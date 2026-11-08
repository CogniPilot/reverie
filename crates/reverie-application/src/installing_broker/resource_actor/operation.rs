//! The sole producer consumes the real qualified Q channel and its actual
//! canonical request. Neither decoded selections nor a callback mint this type.
use super::*;
use reverie_contracts::resource_config::ResourceIdentitySettings;
use reverie_store::storage_identity::{self, StorageIdentityConfig};
use std::time::{SystemTime, UNIX_EPOCH};
mod claim;
mod preview;
mod receipt;
pub use claim::{ClaimedRamOperation, RamClaimFailure, RamPreparationFailure};
pub use receipt::{CommittedRamFailure, CommittedRamOperation};

#[must_use = "move the whole actual Q owner with the operation; do not reconstruct from IDs"]
pub struct AuthenticatedResourceOperation<'a> {
    website: InstalledResourceWebsite<'a>,
    request: ResourceOperationRequest,
    owner: Option<CurrentResourceOwner>,
    checks: usize,
}
impl<'a> InstalledResourceWebsite<'a> {
    /// One pending action owns the SAME channel. A future L rendezvous must
    /// move this entire owner and its claim, never clone a verifier/receiver.
    pub fn receive_operation(
        mut self,
    ) -> std::result::Result<AuthenticatedResourceOperation<'a>, Box<ResourceActorFailure<'a>>>
    {
        let end = self
            .frame
            .deadline
            .min(Instant::now() + Duration::from_secs(5));
        let request = self.frame.receive(end).and_then(|frame| {
            let request = ResourceOperationRequest::decode(&frame)?;
            if let ResourceRequestSelection::Apply {
                profile_version, ..
            } = request.selection()
            {
                request.require_profile_version(*profile_version)?;
            }
            Ok(request)
        });
        let request = match request {
            Ok(request) => request,
            Err(cause) => {
                return Err(Box::new(ResourceActorFailure {
                    frame: self.frame,
                    cause,
                }));
            }
        };
        let mut operation = AuthenticatedResourceOperation {
            website: self,
            request,
            owner: None,
            checks: 0,
        };
        match operation.assert_current() {
            Ok(()) => Ok(operation),
            Err(cause) => Err(Box::new(ResourceActorFailure {
                frame: operation.website.frame,
                cause,
            })),
        }
    }
}
impl AuthenticatedResourceOperation<'_> {
    pub(crate) fn assert_reservation_gate(
        &self,
        gate: &crate::reservation_gate::ReservationGate,
    ) -> Result<()> {
        need(
            self.website
                .frame
                .broker
                .resource_reservations()?
                .is_some_and(|actual| std::ptr::eq(actual, gate)),
            "RESOURCE_ACTOR_GATE_CHANGED",
        )?;
        self.assert_live()
    }
    /// Immutable selection decoded from this channel's actual request. A
    /// caller-supplied employee/approval cannot substitute for this selection.
    pub fn request(&self) -> &ResourceOperationRequest {
        &self.request
    }
    /// Effect consumers must join the SAME actual installing service, never
    /// merely equal configuration data or a second broker on the same paths.
    pub fn assert_broker(&self, broker: &InstallingBroker) -> Result<()> {
        need(
            std::ptr::eq(self.website.frame.broker, broker),
            "RESOURCE_ACTOR_BROKER_CHANGED",
        )?;
        self.assert_live()
    }
    pub fn current_owner(&self) -> Result<&CurrentResourceOwner> {
        self.assert_live()?;
        self.owner.as_ref().ok_or(ResourceActorError::Refused(
            "RESOURCE_ACTOR_OWNER_CONTEXT_REQUIRED",
        ))
    }
    pub fn assert_current(&mut self) -> Result<()> {
        let result = self.current();
        self.website.frame.failed |= result.is_err();
        result
    }
    fn current(&mut self) -> Result<()> {
        let frame = &mut self.website.frame;
        let end = frame.deadline.min(Instant::now() + Duration::from_secs(5));
        frame.guard_bootstrap(end)?;
        self.checks += 1;
        need(self.checks <= 256, "RESOURCE_ACTOR_CHALLENGE_BOUND")?;
        let nonce = reverie_host::resource_facts::fresh_owner_nonce()?;
        frame.send(&self.request.owner_challenge(&nonce)?, end)?;
        let current = self
            .request
            .parse_owner_reply(&frame.receive(end)?, &nonce)?;
        expiry(&current)?;
        let settings = ResourceIdentitySettings::capture_worker_config(
            frame
                .snapshot
                .as_ref()
                .expect("actual installed snapshot")
                .configuration(),
        )
        .map_err(GateError::from)?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        let metadata = storage_identity::read_company_metadata(&identity)
            .map_err(GateError::from)
            .map_err(Into::into);
        frame
            .retain_stateless_result(metadata)?
            .require_resource_owner(self.request.employee_id(), current.owner())?;
        need(
            self.owner
                .as_ref()
                .is_none_or(|original| original == &current),
            "RESOURCE_ACTOR_OWNER_CHANGED",
        )?;
        self.owner = Some(current);
        self.assert_live()
    }
    /// Adjacent cancellation check only: exact original private facts/current
    /// installation and live kernel socket peer. No new engine/process/file
    /// descriptor producer follows the operation's final native bracket.
    pub fn assert_live(&self) -> Result<()> {
        let frame = &self.website.frame;
        frame.assert_metadata(frame.deadline)?;
        expiry(self.owner.as_ref().ok_or(ResourceActorError::Refused(
            "RESOURCE_ACTOR_OWNER_CONTEXT_REQUIRED",
        ))?)?;
        let Transport::Retained(channel) = &frame.transport else {
            return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE"));
        };
        channel.require_connected()?;
        Ok(())
    }
    pub fn close_channel_component(&mut self, end: Instant) -> Result<WorkerLaunchClose> {
        self.website.frame.close(end)
    }
}
fn expiry(owner: &CurrentResourceOwner) -> Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ResourceActorError::Refused("RESOURCE_ACTOR_OWNER_EXPIRED"))?
        .as_millis();
    let expires = u128::from(owner.expires_at_epoch_ms());
    need(
        expires > now && expires - now <= 300_000,
        "RESOURCE_ACTOR_OWNER_EXPIRED",
    )
}
