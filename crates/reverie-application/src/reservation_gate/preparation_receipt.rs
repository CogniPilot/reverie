//! Publication identity from the actual successful CAS/reload/ACK and checked
//! admission exit. Receipt bytes alone cannot reconstruct this live owner.
use super::*;
use reverie_contracts::reservation_policy::PreparedPolicyRecord;
use reverie_core::operations::JournalDigest;
use reverie_host::reservation_control::PolicyBinding;
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Eq, PartialEq)]
enum SnapshotRebase {
    Unused,
    Attempted,
    Adopted,
    Failed,
}

/// A successful policy publication on one retained operation. This proves no
/// launch, pool membership, readiness or capacity release.
pub struct CommittedPolicy {
    record: PreparedPolicyRecord,
    gate: Weak<Inner>,
    owner: Weak<AtomicBool>,
    candidate: Arc<ValidatedWorkerSnapshot>,
    binding: PolicyBinding,
    before: Arc<ValidatedWorkerSnapshot>,
    installed: Arc<ValidatedWorkerSnapshot>,
    ram_selection: Option<JournalDigest>,
    rebase: SnapshotRebase,
}
impl CommittedPolicy {
    pub(super) fn after_commit(
        claim: &RetainedPreparation,
        record: PreparedPolicyRecord,
        ram_selection: Option<JournalDigest>,
    ) -> Self {
        let phase = claim.policy.as_ref().expect("successful policy commit");
        Self {
            record,
            gate: Arc::downgrade(&claim.gate),
            owner: Arc::downgrade(&claim.live),
            candidate: phase.candidate.clone(),
            binding: phase.binding.clone(),
            before: phase.before.clone(),
            installed: phase
                .installed_snapshot
                .as_ref()
                .expect("actual successful installed publication")
                .clone(),
            ram_selection,
            rebase: SnapshotRebase::Unused,
        }
    }
    /// Immutable receipt DATA; operation identity is not an owner grant.
    pub fn operation_id(&self) -> &JournalId {
        self.record.operation_id()
    }
    pub fn digest(&self) -> &JournalDigest {
        self.record.digest()
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        self.record.canonical_bytes()
    }
    /// Recheck the exact installed broker and still-live publication owner
    /// before an authenticated operation advances its expected revision.
    /// The caller must retain its actual authority and recheck it at effects.
    pub fn assert_current(
        &self,
        broker: &crate::installing_broker::InstallingBroker,
        operation: &JournalId,
    ) -> Result<()> {
        let gate = broker.resource_reservations()?.ok_or(GateError::Refused(
            "RESOURCE_PREPARATION_PUBLICATION_NOT_CURRENT",
        ))?;
        self.assert_gate_current(gate, operation)
    }
    /// Only a real RAM publication for this same live claim can advance an
    /// authenticated operation's original expected snapshot. No caller config
    /// or parsed receipt bytes are accepted, and ordinary commits refuse.
    pub(crate) fn ram_snapshot_for(
        &mut self,
        broker: &crate::installing_broker::InstallingBroker,
        claim: &RetainedPreparation,
        policy: &reverie_contracts::ram_migration::RamMigrationPolicy,
        expected_before: &Arc<ValidatedWorkerSnapshot>,
    ) -> Result<Arc<ValidatedWorkerSnapshot>> {
        need(
            self.rebase == SnapshotRebase::Unused,
            "RAM_PUBLICATION_REBASE_ALREADY_ATTEMPTED",
        )?;
        self.rebase = SnapshotRebase::Attempted;
        let result = self.observe_ram_snapshot(broker, claim, policy, expected_before);
        self.rebase = if result.is_ok() {
            SnapshotRebase::Adopted
        } else {
            SnapshotRebase::Failed
        };
        result
    }
    fn observe_ram_snapshot(
        &self,
        broker: &crate::installing_broker::InstallingBroker,
        claim: &RetainedPreparation,
        policy: &reverie_contracts::ram_migration::RamMigrationPolicy,
        expected_before: &Arc<ValidatedWorkerSnapshot>,
    ) -> Result<Arc<ValidatedWorkerSnapshot>> {
        let gate = broker
            .resource_reservations()?
            .ok_or(GateError::Refused("RAM_PUBLICATION_OWNER_CHANGED"))?;
        need(
            Arc::ptr_eq(&gate.inner, &claim.gate)
                && self.operation_id() == claim.operation_id()
                && claim.store.is_some()
                && self.owner.upgrade().is_some_and(|owner| {
                    Arc::ptr_eq(&owner, &claim.live) && owner.load(Ordering::Acquire)
                })
                && self.ram_selection.as_ref() == Some(policy.digest())
                && reverie_contracts::profiles_v1::equivalent(policy.profile(), claim.profile())
                && Arc::ptr_eq(&self.before, expected_before)
                && Arc::ptr_eq(&self.installed, &gate.inner.installed.snapshot()?),
            "RAM_PUBLICATION_OWNER_CHANGED",
        )?;
        self.assert_gate_current(gate, claim.operation_id())?;
        Ok(self.installed.clone())
    }
    pub(super) fn assert_gate_current(
        &self,
        gate: &ReservationGate,
        operation: &JournalId,
    ) -> Result<()> {
        need(
            self.operation_id() == operation
                && self
                    .gate
                    .upgrade()
                    .is_some_and(|original| Arc::ptr_eq(&original, &gate.inner))
                && self
                    .owner
                    .upgrade()
                    .is_some_and(|owner| owner.load(Ordering::Acquire)),
            "RESOURCE_PREPARATION_PUBLICATION_NOT_CURRENT",
        )?;
        need(
            reverie_contracts::worker_config::equivalent(
                gate.inner.config()?.configuration(),
                self.candidate.configuration(),
            ),
            "RESOURCE_PREPARATION_PUBLICATION_NOT_CURRENT",
        )?;
        super::preparation_policy::validate_bound_policy(
            &self.binding,
            self.candidate.configuration(),
        )
    }
}
impl RetainedPreparation {
    /// Join the immutable actual Q request to the original retained draft and
    /// this actual profile/claim. This is read-side binding, not authorization.
    pub(crate) fn assert_ram_approval(
        &self,
        request: &reverie_contracts::resource_actor::ResourceOperationRequest,
        policy: &reverie_contracts::ram_migration::RamMigrationPolicy,
    ) -> Result<()> {
        use reverie_contracts::resource_actor::ResourceRequestSelection;
        let ResourceRequestSelection::Apply {
            employee_id,
            draft_id,
            operation_id,
            reservation_id,
            target_sid,
            profile_version,
            profile_digest,
            preview_digest,
            ram_policy_digest,
        } = request.selection()
        else {
            return Err(GateError::Refused("RAM_APPROVAL_REQUIRED"));
        };
        let digest = reverie_contracts::profiles_v1::profile_digest(self.profile())
            .map_err(crate::resource_staging::ResourceServiceError::from)?
            .to_hex();
        need(
            self.store.is_some()
                && self.live.load(Ordering::Acquire)
                && employee_id == self.profile().binding().employee()
                && *draft_id == self.draft.id()
                && operation_id == self.operation_id()
                && *operation_id == self.draft.operation()
                && reservation_id == &self.view.record().data().reservation_id
                && *reservation_id == self.draft.reservation()
                && target_sid == self.profile().binding().target_session()
                && target_sid.as_str() == self.draft.target().as_str()
                && *profile_version == self.profile().version()
                && profile_digest.as_str() == digest
                && *preview_digest == self.draft.digest()?
                && ram_policy_digest == policy.digest()
                && reverie_contracts::profiles_v1::equivalent(policy.profile(), self.profile()),
            "RAM_APPROVAL_CHANGED",
        )?;
        request
            .require_profile_version(self.profile().version())
            .map_err(|_| GateError::Refused("RAM_APPROVAL_CHANGED"))
    }
}
