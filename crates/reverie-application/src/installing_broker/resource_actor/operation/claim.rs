//! Initial whole-owner claim producer. It remains unavailable in the wire
//! dispatcher until the complete closed continuation has been implemented.
use super::*;
use crate::reservation_gate::{PreparationIntentFacts, RetainedPreparation};
use reverie_contracts::ram_migration::RamMigrationPolicy;

enum ClaimPhase {
    Attempt,
    Claimed {
        claim: Box<RetainedPreparation>,
        policy: Box<RamMigrationPolicy>,
    },
}
struct RamClaimOwner<'a> {
    auth: AuthenticatedResourceOperation<'a>,
    phase: ClaimPhase,
    source_failure: Option<Box<crate::installing_broker::source::RamSourceDraftFailure>>,
}
impl RamClaimOwner<'_> {
    fn continuation(&mut self, expected: ResourceContinuationVerb) -> Result<()> {
        let ClaimPhase::Claimed { claim, .. } = &self.phase else {
            return Err(ResourceActorError::Refused("RESOURCE_RAM_CLAIM_REQUIRED"));
        };
        self.auth
            .receive_continuation(claim.operation_id(), expected)
    }
    fn commit(&mut self) -> Result<crate::reservation_gate::CommittedPolicy> {
        self.continuation(ResourceContinuationVerb::Prepare)?;
        let ClaimPhase::Claimed { claim, policy } = &mut self.phase else {
            return Err(ResourceActorError::Refused("RESOURCE_RAM_CLAIM_REQUIRED"));
        };
        claim.assert_ram_approval(self.auth.request(), policy)?;
        let committed = claim.commit_ram_configuration(policy).map_err(Into::into);
        self.auth.website.frame.retain_stateless_result(committed)
    }
}
#[must_use = "the entire Q, source and claim domain must remain owned"]
pub struct ClaimedRamOperation<'a> {
    owner: Option<Box<RamClaimOwner<'a>>>,
}
#[must_use = "this failure retains the original Q hold and every partial source/claim owner"]
pub struct RamClaimFailure<'a> {
    operation: ClaimedRamOperation<'a>,
    cause: ResourceActorError,
}
#[must_use = "retain the same preparation or adoption failure owner"]
pub enum RamPreparationFailure<'a> {
    Preparation(Box<RamClaimFailure<'a>>),
    Adoption(Box<super::CommittedRamFailure<'a>>),
}
impl<'a> AuthenticatedResourceOperation<'a> {
    pub fn claim_ram_preparation(
        self,
    ) -> std::result::Result<ClaimedRamOperation<'a>, Box<RamClaimFailure<'a>>> {
        let mut operation = ClaimedRamOperation {
            owner: Some(Box::new(RamClaimOwner {
                auth: self,
                phase: ClaimPhase::Attempt,
                source_failure: None,
            })),
        };
        let result = operation.claim();
        match result {
            Ok(()) => Ok(operation),
            Err(cause) => {
                operation.owner_mut().auth.website.frame.failed = true;
                Err(Box::new(RamClaimFailure { operation, cause }))
            }
        }
    }
}
impl<'a> ClaimedRamOperation<'a> {
    fn owner_mut(&mut self) -> &mut RamClaimOwner<'a> {
        self.owner
            .as_deref_mut()
            .expect("whole RAM claim owner retained")
    }
    fn claim(&mut self) -> Result<()> {
        let owner = self.owner_mut();
        owner.auth.assert_current()?;
        let broker = owner.auth.website.frame.broker;
        let gate = broker
            .resource_reservations()?
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_GATE_REQUIRED"))?;
        let entered = gate.enter_ram_resource_draft(&owner.auth)?;
        match broker.retain_ram_resource_draft(entered) {
            Ok((claim, policy)) => {
                owner.phase = ClaimPhase::Claimed {
                    claim: Box::new(claim),
                    policy: Box::new(policy),
                }
            }
            Err(failure) => {
                let code = failure.code();
                owner.source_failure = Some(failure);
                return Err(ResourceActorError::Refused(code));
            }
        }
        owner.auth.assert_current()
    }
    pub fn request(&self) -> &ResourceOperationRequest {
        self.owner
            .as_deref()
            .expect("whole RAM claim owner retained")
            .auth
            .request()
    }
    /// The original publication intent is created before the website's normal
    /// Session publication. No configuration or source stop is implied.
    pub fn begin_prepare(&mut self) -> Result<PreparationIntentFacts> {
        let owner = self.owner_mut();
        let result = (|| {
            owner.auth.assert_current()?;
            let ClaimPhase::Claimed { claim, policy } = &mut owner.phase else {
                return Err(ResourceActorError::Refused("RESOURCE_RAM_CLAIM_REQUIRED"));
            };
            claim.assert_ram_approval(owner.auth.request(), policy)?;
            let result = claim.begin_prepare().map_err(Into::into);
            owner.auth.website.frame.retain_stateless_result(result)
        })();
        owner.auth.website.frame.failed |= result.is_err();
        result
    }
    pub fn confirm_publication(&mut self) -> Result<()> {
        let owner = self.owner_mut();
        let result = (|| {
            owner.continuation(ResourceContinuationVerb::Publication)?;
            let ClaimPhase::Claimed { claim, policy } = &mut owner.phase else {
                return Err(ResourceActorError::Refused("RESOURCE_RAM_CLAIM_REQUIRED"));
            };
            claim.assert_ram_approval(owner.auth.request(), policy)?;
            let result = claim.confirm_publication().map_err(Into::into);
            owner.auth.website.frame.retain_stateless_result(result)
        })();
        owner.auth.website.frame.failed |= result.is_err();
        result
    }
    /// Transfer only the actual checked-close commit receipt into the existing
    /// same-operation adoption. No snapshot DATA can substitute for this move.
    pub fn commit_ram_policy(
        mut self,
    ) -> std::result::Result<super::CommittedRamOperation<'a>, Box<RamPreparationFailure<'a>>> {
        let result = self.owner_mut().commit();
        let receipt = match result {
            Ok(receipt) => receipt,
            Err(cause) => {
                self.owner_mut().auth.website.frame.failed = true;
                return Err(Box::new(RamPreparationFailure::Preparation(Box::new(
                    RamClaimFailure {
                        operation: self,
                        cause,
                    },
                ))));
            }
        };
        let owner = *self.owner.take().expect("whole original RAM owner");
        let ClaimPhase::Claimed { claim, policy } = owner.phase else {
            unreachable!("successful commit used the actual claimed phase")
        };
        owner
            .auth
            .adopt_committed_ram_policy(*claim, *policy, receipt)
            .map_err(|failure| Box::new(RamPreparationFailure::Adoption(failure)))
    }
    pub fn disconnect_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        let frame = &mut self.owner_mut().auth.website.frame;
        frame.failed = true;
        match &mut frame.transport {
            Transport::Retained(channel) => channel.disconnect_for_worker().map_err(Into::into),
            _ => Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE")),
        }
    }
}
impl Drop for ClaimedRamOperation<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl RamClaimFailure<'_> {
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
impl std::fmt::Debug for RamClaimFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RamClaimFailure")
            .field("cause", &self.cause)
            .field(
                "source",
                &self
                    .operation
                    .owner
                    .as_ref()
                    .and_then(|owner| owner.source_failure.as_ref()),
            )
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for RamClaimFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for RamClaimFailure<'_> {}
impl RamPreparationFailure<'_> {
    pub fn cause(&self) -> &ResourceActorError {
        match self {
            Self::Preparation(owner) => owner.cause(),
            Self::Adoption(owner) => owner.cause(),
        }
    }
    pub fn disconnect_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        match self {
            Self::Preparation(owner) => owner.disconnect_for_worker(),
            Self::Adoption(owner) => owner.disconnect_for_worker(),
        }
    }
}
impl std::fmt::Display for RamPreparationFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause().fmt(f)
    }
}
impl std::fmt::Debug for RamPreparationFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Preparation(owner) => owner.fmt(f),
            Self::Adoption(owner) => owner.fmt(f),
        }
    }
}
impl std::error::Error for RamPreparationFailure<'_> {}
