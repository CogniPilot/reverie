//! The original draft entry and durable reservation phases have one owner.
//! Installing composition can fence a real source resource BETWEEN these two
//! phases while retaining this same actual admission, without reentry/callbacks.
use super::*;
use reverie_contracts::reservation_draft::DraftRecord;
use reverie_core::{operations::OperationRequest, profiles::ResourceProfile};
use reverie_store::operations::ClaimSelection;

pub(crate) struct EnteredResourceDraft<'a> {
    gate: &'a ReservationGate,
    draft: DraftRecord,
    profile: ResourceProfile,
    request: OperationRequest,
    admission: admission::Admission,
}
pub(crate) struct DraftRetentionFailure {
    pub(crate) cause: GateError,
    pub(crate) may_have_claimed: bool,
}
impl ReservationGate {
    pub(crate) fn enter_resource_draft(
        &self,
        id: &JournalId,
        digest: &reverie_core::operations::JournalDigest,
    ) -> Result<EnteredResourceDraft<'_>> {
        self.enter_resource_draft_bounded(id, digest, AdmissionBounds::default())
    }
    pub(super) fn enter_resource_draft_bounded(
        &self,
        id: &JournalId,
        digest: &reverie_core::operations::JournalDigest,
        bounds: AdmissionBounds,
    ) -> Result<EnteredResourceDraft<'_>> {
        let metadata = reservation_control::read_draft(self.inner.config()?.as_ref(), id)?;
        let draft = DraftRecord::capture(&metadata, id, &self.inner.scope, digest)?;
        let profile = self.inner.profile(&draft.employee()?)?;
        draft.assert_current_profile(profile.as_ref())?;
        let profile = profile.expect("checked current profile");
        let request = draft.comparison_request(&profile)?;
        let admission = self.inner.admit(bounds)?;
        Ok(EnteredResourceDraft {
            gate: self,
            draft,
            profile,
            request,
            admission,
        })
    }
}
impl EnteredResourceDraft<'_> {
    pub(super) fn retain_ram(
        self,
        journal: Arc<super::ram_authority::RamJournalAuthority>,
        policy: reverie_contracts::ram_migration::RamMigrationPolicy,
    ) -> std::result::Result<
        (
            RetainedPreparation,
            reverie_contracts::ram_migration::RamMigrationPolicy,
        ),
        Box<super::ram_claim::RamDraftRetentionFailure>,
    > {
        use super::ram_claim::{RamDraftRetentionFailure, RamPartialClaim};
        let mut admission = self.admission;
        let mut claimed = false;
        let result = self.gate.inner.claim_reservation(
            &self.draft.key(),
            &self.request,
            ClaimSelection {
                operation_id: Some(self.draft.operation()),
                reservation_id: Some(self.draft.reservation()),
                reserved_sid: None,
            },
            Some(&self.draft),
            &mut claimed,
        );
        let context = match result {
            Ok(context) => context,
            Err(cause) => {
                let cause = admission.conclude::<()>(Err(cause)).unwrap_err();
                return Err(Box::new(RamDraftRetentionFailure {
                    may_have_claimed: claimed || journal_uncertain(&cause),
                    cause,
                    policy,
                    journal,
                    partial: RamPartialClaim::None,
                }));
            }
        };
        let captured = match self.gate.capture_preparation_context(&context) {
            Ok(captured) => captured,
            Err(cause) => {
                let cause = admission.conclude::<()>(Err(cause)).unwrap_err();
                return Err(Box::new(RamDraftRetentionFailure {
                    cause,
                    may_have_claimed: true,
                    policy,
                    journal,
                    partial: RamPartialClaim::Context(Box::new(context)),
                }));
            }
        };
        let mut claim = self
            .gate
            .retained_preparation(context, self.draft, captured);
        claim.ram_authority = Some(journal.clone());
        if let Err(cause) = claim.install_ram_journal(&mut admission) {
            let cause = admission.conclude::<()>(Err(cause)).unwrap_err();
            return Err(Box::new(RamDraftRetentionFailure { cause, may_have_claimed: true, policy, journal, partial: RamPartialClaim::Preparation(Box::new(claim)) }));
        }
        match admission.finish_claim(&claim.terminal) {
            Ok(()) => Ok((claim, policy)),
            Err(cause) => Err(Box::new(RamDraftRetentionFailure {
                cause,
                may_have_claimed: true,
                policy,
                journal,
                partial: RamPartialClaim::Preparation(Box::new(claim)),
            })),
        }
    }
    pub(super) fn bind_ram_authority(
        &self,
        journal: &Arc<super::ram_authority::RamJournalAuthority>,
    ) -> Result<()> {
        self.admission.bind_ram_authority(journal)
    }
    pub(super) fn assert_observation(
        &self,
        observed: &reverie_contracts::reservation_observation::ReservationObservation,
    ) -> Result<()> {
        need(
            self.request.observation_digest == observed.digest(),
            "STALE_CAPACITY_SNAPSHOT",
        )
    }
    pub(super) fn assert_ram_approval(
        &self,
        request: &reverie_contracts::resource_actor::ResourceOperationRequest,
        policy: &reverie_contracts::ram_migration::RamMigrationPolicy,
    ) -> Result<()> {
        super::preparation_receipt::assert_ram_draft_approval(
            request,
            &self.draft,
            &self.profile,
            policy,
        )
    }
    pub(crate) fn profile(&self) -> &ResourceProfile {
        &self.profile
    }
    pub(crate) fn operation(&self) -> JournalId {
        self.draft.operation()
    }
    pub(crate) fn installed_is(
        &self,
        installed: &Arc<crate::installing_broker::InstalledWorker>,
    ) -> bool {
        Arc::ptr_eq(&self.gate.inner.installed, installed)
    }
    pub(crate) fn abort(self) -> Result<()> {
        self.admission.abort()
    }
    pub(crate) fn retain(self) -> std::result::Result<RetainedPreparation, DraftRetentionFailure> {
        let mut claimed = false;
        let selected = ClaimSelection {
            operation_id: Some(self.draft.operation()),
            reservation_id: Some(self.draft.reservation()),
            reserved_sid: None,
        };
        let body = self.gate.inner.claim_reservation(
            &self.draft.key(),
            &self.request,
            selected,
            Some(&self.draft),
            &mut claimed,
        );
        let result = match body {
            Err(error) => self.admission.conclude(Err(error)),
            Ok(context) => self
                .gate
                .retain_context(self.admission, context, self.draft),
        };
        result.map_err(|error| {
            let may_have_claimed = claimed || journal_uncertain(&error);
            let cause = if claimed {
                match error {
                    GateError::Journal(error) if error.is_uncertain() => GateError::Journal(error),
                    other => GateError::ClaimUncertain {
                        cause: Box::new(other),
                    },
                }
            } else {
                error
            };
            DraftRetentionFailure {
                cause,
                may_have_claimed,
            }
        })
    }
}
fn journal_uncertain(error: &GateError) -> bool {
    match error {
        GateError::Journal(error) => error.is_uncertain(),
        GateError::SharedJournal(error) => error.is_uncertain(),
        GateError::ClaimUncertain { .. } => true,
        GateError::Finalization { primary, secondary } => {
            journal_uncertain(primary) || journal_uncertain(secondary)
        }
        _ => false,
    }
}
