//! Publication identity from the actual successful CAS/reload/ACK and checked
//! admission exit. Receipt bytes alone cannot reconstruct this live owner.
use super::*;
use reverie_contracts::reservation_policy::PreparedPolicyRecord;
use reverie_core::operations::JournalDigest;
use reverie_host::reservation_control::PolicyBinding;
use std::sync::atomic::{AtomicBool, Ordering};

/// A successful policy publication on one retained operation. This proves no
/// launch, pool membership, readiness or capacity release.
pub struct CommittedPolicy {
    record: PreparedPolicyRecord,
    gate: Weak<Inner>,
    owner: Weak<AtomicBool>,
    candidate: Arc<ValidatedWorkerSnapshot>,
    binding: PolicyBinding,
}
impl CommittedPolicy {
    pub(super) fn after_commit(claim: &RetainedPreparation, record: PreparedPolicyRecord) -> Self {
        let phase = claim.policy.as_ref().expect("successful policy commit");
        Self {
            record,
            gate: Arc::downgrade(&claim.gate),
            owner: Arc::downgrade(&claim.live),
            candidate: phase.candidate.clone(),
            binding: phase.binding.clone(),
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
