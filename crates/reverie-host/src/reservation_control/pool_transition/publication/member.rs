//! One member edit reuses the original control pending file and checked
//! configuration, control-binding and actor publication.
use super::*;
use crate::worker_pool::{
    MemberPolicyEditCommitted, MemberPolicyEditRejected, MemberPolicyEditVerified,
    PreparedMemberPolicyEdit,
};
use reverie_contracts::{
    reservation_control::domain_digest, worker_config::config_digest,
    worker_pool::WorkerPoolMemberPolicy,
};
use reverie_core::operations::OperationScope;
use serde::Serialize;

#[derive(Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    operation_id: String,
    employee_id: String,
    session_id: String,
    container_id: String,
    pid: u32,
    process_start: String,
    leaf_identity: (u64, u64),
    member_revision: u64,
    before: WorkerPoolMemberPolicy,
    requested: WorkerPoolMemberPolicy,
}

impl Selection {
    fn capture(edit: &PreparedMemberPolicyEdit) -> Self {
        Self {
            operation_id: edit.operation().as_str().into(),
            employee_id: edit.employee().as_str().into(),
            session_id: edit.session().as_str().into(),
            container_id: edit.container().as_str().into(),
            pid: edit.pid(),
            process_start: edit.process_start().into(),
            leaf_identity: edit.leaf_identity(),
            member_revision: edit.expected_revision(),
            before: edit.before(),
            requested: edit.proposed(),
        }
    }
}

#[must_use = "retain the original member edit pending owner through checked completion"]
pub struct MemberPolicyPending {
    pending: PoolTransitionPending,
    identity: Arc<()>,
    admission: Arc<AdmissionAcquisition>,
    selection: Selection,
    end: Instant,
    stop: WorkerStopBudget,
    prepared: Option<PoolPublicationPrepared>,
    published: Option<PoolPublication>,
}

#[must_use = "release only this rejected edit after checked admission close"]
pub struct MemberPolicyCancellation {
    identity: Arc<()>,
    ledger: Arc<FailureLedger>,
}

/// Checked controller commit and durable files of the same edit, still under
/// its original admission. This proves the inputs to the application tuple.
pub struct MemberPolicyPublication<'a> {
    pending: &'a MemberPolicyPending,
    edit: &'a PreparedMemberPolicyEdit,
    admission: &'a AdmissionLock,
}

impl MemberPolicyPublication<'_> {
    pub fn transition(&self) -> Result<&WorkerPoolConfigurationTransition> {
        self.pending
            .assert_published_for_edit(self.edit, self.admission)?;
        self.pending.pending.publication_transition(
            self.pending
                .published
                .as_ref()
                .expect("verified publication"),
        )
    }

    pub fn assert_current(&self) -> Result<()> {
        self.pending
            .assert_published_for_edit(self.edit, self.admission)
    }
}

impl MemberPolicyPending {
    pub fn establish(
        config: &ReservationConfiguration,
        binding: &ControlBinding,
        admission: &AdmissionLock,
        transition: Arc<WorkerPoolConfigurationTransition>,
        prepared: &PreparedMemberPolicyEdit,
        scope: &OperationScope,
    ) -> Result<Self> {
        check_deadline(prepared.deadline())?;
        let member = transition
            .member_edit()
            .ok_or(ControlHostError::Refused("POOL_MEMBER_POLICY_REQUIRED"))?;
        need(
            &config_digest(config.configuration()) == prepared.source_digest()
                && &config_digest(transition.before()) == prepared.source_digest()
                && member.employee() == prepared.employee()
                && member.previous() == prepared.before()
                && member.requested() == prepared.proposed()
                && member.previous_revision() == prepared.expected_revision(),
            "POOL_MEMBER_POLICY_CHANGED",
        )?;
        let domain = domain_digest(config.configuration())
            .map_err(|error| ControlHostError::Refused(error.code()))?;
        need(
            domain == *binding.domain() && binding.matches_metadata(&read_marker(config)?),
            "RESERVATION_BINDING_CHANGED",
        )?;
        guard_layout(config, binding, admission)?;
        let selection = Selection::capture(prepared);
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schema": "reverie-pool-member-policy-pending-v1",
            "state": "RECONCILIATION_REQUIRED",
            "companyId": scope.company_id.as_str(),
            "ownerScopeDigest": scope.owner_scope_digest.as_str(),
            "selection": selection,
            "beforeConfigurationDigest": config_digest(transition.before()).to_hex(),
            "afterConfigurationDigest": config_digest(transition.after()).to_hex(),
        }))
        .map_err(|_| ControlHostError::Refused("POOL_MEMBER_POLICY_ENCODING"))?;
        let intent = PendingIntent::Member { transition, bytes };
        let pending =
            PoolTransitionPending::establish_selected(config, binding, admission, intent)?;
        Ok(Self {
            pending,
            identity: Arc::clone(prepared.identity()),
            admission: Arc::clone(&admission.acquisition),
            selection,
            end: prepared.deadline(),
            stop: prepared.stop_budget().clone(),
            prepared: None,
            published: None,
        })
    }

    pub fn prepare_publication(
        &mut self,
        source: &Path,
        actor: ActorRebindPlan,
        admission: &AdmissionLock,
    ) -> Result<()> {
        self.assert_admission(admission)?;
        let PendingIntent::Member { transition, .. } = &self.pending.owner().proof.intent else {
            return Err(ControlHostError::Refused("POOL_MEMBER_POLICY_REQUIRED"));
        };
        let transition = Arc::clone(transition);
        let prepared = self.pending.prepare_selected_publication(
            source, transition, actor, admission, &self.stop, self.end,
        )?;
        self.prepared = Some(prepared);
        Ok(())
    }

    pub(crate) fn assert_ready_for_edit(
        &self,
        edit: &PreparedMemberPolicyEdit,
        admission: &AdmissionLock,
    ) -> Result<()> {
        self.assert_selection(edit)?;
        self.assert_admission(admission)?;
        let (owner, state) = self.publication_state(Phase::Prepared)?;
        let fence =
            PoolRenameFence::new(&owner.proof, &owner.file, admission, &state.stop, state.end);
        fence.assert_current()?;
        state.assert_before(&owner.proof)?;
        fence.assert_current()
    }

    pub fn publish(
        &mut self,
        edit: &PreparedMemberPolicyEdit,
        verified: &MemberPolicyEditVerified,
        admission: &AdmissionLock,
    ) -> Result<()> {
        verified
            .assert_prepared(edit)
            .map_err(|_| ControlHostError::Refused("POOL_MEMBER_POLICY_VERIFICATION_CHANGED"))?;
        self.assert_ready_for_edit(edit, admission)?;
        let prepared = self.prepared.as_ref().ok_or(ControlHostError::Refused(
            "POOL_MEMBER_POLICY_PUBLICATION_PHASE",
        ))?;
        self.published = Some(self.pending.publish_prepared(prepared, admission)?);
        Ok(())
    }

    pub(crate) fn assert_published_for_edit(
        &self,
        edit: &PreparedMemberPolicyEdit,
        admission: &AdmissionLock,
    ) -> Result<()> {
        self.assert_selection(edit)?;
        self.assert_admission(admission)?;
        let (owner, state) = self.publication_state(Phase::Published)?;
        need(
            self.published.is_some(),
            "POOL_MEMBER_POLICY_PUBLICATION_PHASE",
        )?;
        let fence =
            PoolRenameFence::new(&owner.proof, &owner.file, admission, &state.stop, state.end);
        fence.assert_current()?;
        state
            .published
            .as_ref()
            .ok_or(ControlHostError::Refused(
                "POOL_MEMBER_POLICY_PUBLICATION_PHASE",
            ))?
            .assert_current()?;
        fence.assert_current()
    }

    pub fn actor_rebind(&self) -> Result<&ActorRebound> {
        let published = self.published.as_ref().ok_or(ControlHostError::Refused(
            "POOL_MEMBER_POLICY_PUBLICATION_PHASE",
        ))?;
        self.pending.publication_actor_rebind(published)
    }

    pub fn committed_publication<'a>(
        &'a self,
        edit: &'a PreparedMemberPolicyEdit,
        committed: &MemberPolicyEditCommitted,
        admission: &'a AdmissionLock,
    ) -> Result<MemberPolicyPublication<'a>> {
        committed
            .assert_prepared(edit)
            .map_err(|_| ControlHostError::Refused("POOL_MEMBER_POLICY_COMMIT_CHANGED"))?;
        self.assert_published_for_edit(edit, admission)?;
        Ok(MemberPolicyPublication {
            pending: self,
            edit,
            admission,
        })
    }

    pub fn terminal(
        &self,
        edit: &PreparedMemberPolicyEdit,
        committed: &MemberPolicyEditCommitted,
    ) -> Result<PoolTerminal> {
        self.assert_selection(edit)?;
        committed
            .assert_prepared(edit)
            .map_err(|_| ControlHostError::Refused("POOL_MEMBER_POLICY_COMMIT_CHANGED"))?;
        let published = self.published.as_ref().ok_or(ControlHostError::Refused(
            "POOL_MEMBER_POLICY_PUBLICATION_PHASE",
        ))?;
        self.pending.terminal(published)
    }

    pub fn release_terminal(&mut self, terminal: &PoolTerminal) -> Result<()> {
        self.admission.assert_closed()?;
        self.pending.release_terminal(terminal)
    }

    pub fn rejected(
        &self,
        edit: &PreparedMemberPolicyEdit,
        rejected: &MemberPolicyEditRejected,
        admission: &AdmissionLock,
    ) -> Result<MemberPolicyCancellation> {
        rejected
            .assert_prepared(edit)
            .map_err(|_| ControlHostError::Refused("POOL_MEMBER_POLICY_REJECTION_CHANGED"))?;
        self.assert_ready_for_edit(edit, admission)?;
        Ok(self.cancellation())
    }

    /// Cancel the exact prepared edit while its original files and admission
    /// are still current. Claiming the unissued state permanently denies send.
    pub fn cancel_unissued(
        &self,
        edit: &PreparedMemberPolicyEdit,
        admission: &AdmissionLock,
    ) -> Result<MemberPolicyCancellation> {
        self.assert_ready_for_edit(edit, admission)?;
        need(
            edit.claim_unissued(),
            "POOL_MEMBER_POLICY_DISPATCH_ALREADY_CLAIMED",
        )?;
        Ok(self.cancellation())
    }

    fn cancellation(&self) -> MemberPolicyCancellation {
        MemberPolicyCancellation {
            identity: Arc::clone(&self.identity),
            ledger: Arc::clone(&self.pending.owner().ledger),
        }
    }

    /// Finish a confirmed no-write refusal or cancellation after closing the original
    /// admission. Reobserve the same old configuration before removing its
    /// denial file.
    pub fn release_rejected(&mut self, cancellation: MemberPolicyCancellation) -> Result<()> {
        self.admission.assert_closed()?;
        let owner = self.pending.owner_mut();
        owner.ledger.live()?;
        let result = (|| {
            need(
                Arc::ptr_eq(&self.identity, &cancellation.identity)
                    && Arc::ptr_eq(&owner.ledger, &cancellation.ledger),
                "POOL_MEMBER_POLICY_REJECTION_CHANGED",
            )?;
            let state = owner.publication.as_mut().ok_or(ControlHostError::Refused(
                "POOL_MEMBER_POLICY_PUBLICATION_PHASE",
            ))?;
            need(
                state.phase == Phase::Prepared,
                "POOL_MEMBER_POLICY_PUBLICATION_PHASE",
            )?;
            owner.proof.assert_current()?;
            state.assert_before(&owner.proof)?;
            owner.proof.assert_current()?;
            owner
                .file
                .release_with_stop(state.end, &state.stop)
                .map_err(pending_error)?;
            state.phase = Phase::Released;
            Ok(())
        })();
        owner.ledger.finish(result)
    }

    fn assert_selection(&self, edit: &PreparedMemberPolicyEdit) -> Result<()> {
        check_deadline(
            self.stop
                .deadline()
                .map_or(self.end, |stop| stop.min(self.end)),
        )?;
        need(
            Arc::ptr_eq(&self.identity, edit.identity())
                && self.selection == Selection::capture(edit),
            "POOL_MEMBER_POLICY_CHANGED",
        )
    }

    fn assert_admission(&self, admission: &AdmissionLock) -> Result<()> {
        need(
            Arc::ptr_eq(&self.admission, &admission.acquisition),
            "RESERVATION_ORIGINAL_ADMISSION_CHANGED",
        )
    }

    fn publication_state(&self, phase: Phase) -> Result<(&PendingOwner, &PublicationState)> {
        let owner = self.pending.owner();
        owner.ledger.live()?;
        let state = owner.publication.as_ref().ok_or(ControlHostError::Refused(
            "POOL_MEMBER_POLICY_PUBLICATION_PHASE",
        ))?;
        need(state.phase == phase, "POOL_MEMBER_POLICY_PUBLICATION_PHASE")?;
        Ok((owner, state))
    }
}

fn check_deadline(end: Instant) -> Result<()> {
    need(Instant::now() < end, "POOL_MEMBER_POLICY_DEADLINE")
}
