//! Actual Q owner adopts only its same-claim one-shot RAM publication. No
//! caller configuration or parsed receipt can advance the expected snapshot.
use super::*;
use crate::reservation_gate::{CommittedPolicy, RetainedPreparation};
use reverie_contracts::ram_migration::RamMigrationPolicy;
mod start;
pub use start::{PreparedResourceStart, ResourceStartFailure};

struct CommittedRamOwner<'a> {
    auth: AuthenticatedResourceOperation<'a>,
    claim: RetainedPreparation,
    policy: RamMigrationPolicy,
    receipt: CommittedPolicy,
}
impl CommittedRamOwner<'_> {
    fn assert_domain_current(&self) -> Result<()> {
        self.claim
            .assert_ram_approval(&self.auth.request, &self.policy)?;
        self.receipt
            .assert_current(self.auth.website.frame.broker, self.claim.operation_id())?;
        Ok(())
    }
}
/// Owns the actual Q channel/hold and the entire same-operation RAM domain.
/// Socket closure cannot acknowledge domain settlement or release this hold.
#[must_use = "retain the whole RAM operation until genuine domain terminal ownership exists"]
pub struct CommittedRamOperation<'a> {
    owner: Option<Box<CommittedRamOwner<'a>>>,
}
#[must_use = "failure retains the original Q hold, claim, policy and publication receipt"]
pub struct CommittedRamFailure<'a> {
    operation: CommittedRamOperation<'a>,
    cause: ResourceActorError,
}
impl<'a> AuthenticatedResourceOperation<'a> {
    /// Call after commit_ram_configuration returns its checked-closed receipt,
    /// outside lifecycle/admission. A fresh native/current-owner exchange
    /// follows the metadata-only adoption; any refusal poisons THIS operation.
    pub fn adopt_committed_ram_policy(
        self,
        claim: RetainedPreparation,
        policy: RamMigrationPolicy,
        receipt: CommittedPolicy,
    ) -> std::result::Result<CommittedRamOperation<'a>, Box<CommittedRamFailure<'a>>> {
        // Transfer EVERY original owner before even approval or live checks.
        let mut operation = CommittedRamOperation {
            owner: Some(Box::new(CommittedRamOwner {
                auth: self,
                claim,
                policy,
                receipt,
            })),
        };
        let owner = operation.owner_mut();
        let adopted = owner
            .auth
            .adopt_ram_snapshot(&owner.claim, &owner.policy, &mut owner.receipt)
            .and_then(|()| owner.auth.assert_current());
        owner.auth.website.frame.failed |= adopted.is_err();
        match adopted {
            Ok(()) => Ok(operation),
            Err(cause) => Err(Box::new(CommittedRamFailure { operation, cause })),
        }
    }
    fn adopt_ram_snapshot(
        &mut self,
        claim: &RetainedPreparation,
        policy: &RamMigrationPolicy,
        receipt: &mut CommittedPolicy,
    ) -> Result<()> {
        let frame = &mut self.website.frame;
        need(
            !frame.failed && Instant::now() < frame.deadline,
            "RESOURCE_ACTOR_CHANNEL_EXPIRED",
        )?;
        expiry(self.owner.as_ref().ok_or(ResourceActorError::Refused(
            "RESOURCE_ACTOR_OWNER_CONTEXT_REQUIRED",
        ))?)?;
        let Transport::Retained(channel) = &frame.transport else {
            return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE"));
        };
        channel.require_connected()?;
        claim.assert_ram_approval(&self.request, policy)?;
        let original = frame
            .snapshot
            .as_ref()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_NOT_BOUND"))?;
        let installed = receipt.ram_snapshot_for(frame.broker, claim, policy, original)?;
        frame
            .private
            .assert_metadata(installed.configuration(), frame.deadline)?;
        expiry(
            self.owner
                .as_ref()
                .expect("original current owner retained"),
        )?;
        channel.require_connected()?;
        // Only original context configuration DATA changes. Its original
        // native source, cancellation, origin and scoped query owner survive.
        let context = frame
            .context
            .as_ref()
            .expect("authenticated native context")
            .with_applied_configuration(installed.configuration().clone());
        frame.context = Some(context);
        frame.snapshot = Some(installed);
        Ok(())
    }
}
impl<'a> CommittedRamOperation<'a> {
    fn owner(&self) -> &CommittedRamOwner<'a> {
        self.owner
            .as_deref()
            .expect("whole original RAM owner retained")
    }
    fn owner_mut(&mut self) -> &mut CommittedRamOwner<'a> {
        self.owner
            .as_deref_mut()
            .expect("whole original RAM owner retained")
    }
    /// Immutable selection DATA from the original authenticated frame.
    pub fn request(&self) -> &ResourceOperationRequest {
        self.owner().auth.request()
    }
    pub fn policy(&self) -> &RamMigrationPolicy {
        &self.owner().policy
    }
    pub fn assert_current(&mut self) -> Result<()> {
        let owner = self.owner_mut();
        let result = owner
            .assert_domain_current()
            .and_then(|()| owner.auth.assert_current());
        owner.auth.website.frame.failed |= result.is_err();
        result
    }
    pub fn assert_live(&mut self) -> Result<()> {
        let owner = self.owner_mut();
        let result = owner
            .assert_domain_current()
            .and_then(|()| owner.auth.assert_live());
        owner.auth.website.frame.failed |= result.is_err();
        result
    }
    /// Native socket/peer component only. The real domain and SAME Q hold stay
    /// owned even after known disconnect; neither claim close nor reader
    /// finalization is interpreted as a terminal resource outcome.
    pub fn disconnect_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        let frame = &mut self.owner_mut().auth.website.frame;
        frame.failed = true;
        match &mut frame.transport {
            Transport::Retained(channel) => channel.disconnect_for_worker().map_err(Into::into),
            _ => Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE")),
        }
    }
}
impl Drop for CommittedRamOperation<'_> {
    fn drop(&mut self) {
        // No genuine domain-terminal owner exists in this cohort. Preserve
        // the complete claim/store together with the original counted Q hold.
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl CommittedRamFailure<'_> {
    pub fn cause(&self) -> &ResourceActorError {
        &self.cause
    }
    pub fn request(&self) -> &ResourceOperationRequest {
        self.operation.request()
    }
    pub fn disconnect_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        self.operation.disconnect_for_worker()
    }
}
impl std::fmt::Debug for CommittedRamFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommittedRamFailure")
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for CommittedRamFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for CommittedRamFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
