//! The genuine Q request is joined to all approved draft/profile/source fields
//! while one admission is held, before the first durable claim attempt.
use super::*;
use crate::installing_broker::resource_actor::AuthenticatedResourceOperation;
use reverie_contracts::{
    ram_migration::RamMigrationPolicy, resource_actor::ResourceRequestSelection,
};

pub(crate) struct EnteredRamDraft<'a> {
    entry: preparation_draft::EnteredResourceDraft<'a>,
    journal: Arc<ram_authority::RamJournalAuthority>,
    policy: RamMigrationPolicy,
}
pub(crate) struct RamDraftRetentionFailure {
    pub(super) cause: GateError,
    pub(super) may_have_claimed: bool,
    pub(super) policy: RamMigrationPolicy,
    pub(super) journal: Arc<ram_authority::RamJournalAuthority>,
    pub(super) partial: RamPartialClaim,
}
pub(super) enum RamPartialClaim {
    None,
    Context(Box<super::claim::ClaimedContext>),
    Preparation(Box<RetainedPreparation>),
}
impl RamDraftRetentionFailure {
    pub(crate) fn may_have_claimed(&self) -> bool {
        self.may_have_claimed
    }
    pub(crate) fn cause(&self) -> &GateError {
        &self.cause
    }
}
impl std::fmt::Debug for RamDraftRetentionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let operation = match &self.partial {
            RamPartialClaim::None => None,
            RamPartialClaim::Context(context) => Some(&context.view.record().data().id),
            RamPartialClaim::Preparation(claim) => Some(claim.operation_id()),
        };
        f.debug_struct("RamDraftRetentionFailure")
            .field("cause", &self.cause)
            .field("operation", &operation)
            .field("policy", self.policy.digest())
            .field("journal", &self.journal)
            .finish_non_exhaustive()
    }
}
impl ReservationGate {
    pub(crate) fn enter_ram_resource_draft(
        &self,
        operation: &AuthenticatedResourceOperation<'_>,
    ) -> Result<EnteredRamDraft<'_>> {
        let ResourceRequestSelection::Apply {
            draft_id,
            preview_digest,
            ..
        } = operation.request().selection()
        else {
            return Err(GateError::Refused("RAM_APPROVAL_REQUIRED"));
        };
        let journal = ram_authority::RamJournalAuthority::capture(self, operation)?;
        let entry =
            self.enter_resource_draft_bounded(draft_id, preview_digest, journal.bounds())?;
        let checked = (|| {
            entry.bind_ram_authority(&journal)?;
            let profile = entry.profile();
            let (observed, rows) = self.inner.observe_claim(
                &self.inner.scope,
                self.inner.option.pool(),
                profile.binding().employee(),
                profile,
            )?;
            entry.assert_observation(&observed)?;
            let policy = ram_preview::RamPreviewGuard::admitted(self, operation, journal.clone())
                .observe_policy(&self.inner, profile, &rows, &observed)?;
            entry.assert_ram_approval(operation.request(), &policy)?;
            Ok(policy)
        })();
        match checked {
            Ok(policy) => Ok(EnteredRamDraft {
                entry,
                journal,
                policy,
            }),
            Err(error) => finalized(Err(error), entry.abort()),
        }
    }
}
impl EnteredRamDraft<'_> {
    pub(crate) fn entry(&self) -> &preparation_draft::EnteredResourceDraft<'_> {
        &self.entry
    }
    pub(crate) fn abort(self) -> Result<()> {
        self.entry.abort()
    }
    pub(crate) fn retain(
        self,
    ) -> std::result::Result<(RetainedPreparation, RamMigrationPolicy), Box<RamDraftRetentionFailure>>
    {
        let Self {
            entry,
            journal,
            policy,
        } = self;
        entry.retain_ram(journal, policy)
    }
}
