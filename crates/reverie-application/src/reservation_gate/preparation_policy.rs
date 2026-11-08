//! Protected policy transaction phase checks. All fields are private to the
//! real retained preparation; parsed config/hash data cannot construct them.
use super::*;
use reverie_contracts::{
    reservation_policy,
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_host::reservation_control::PolicyBinding;
use std::sync::atomic::{AtomicBool, Ordering};
pub(super) struct PolicyPhase {
    pub(super) before: Arc<ValidatedWorkerSnapshot>,
    pub(super) installed_snapshot: Option<Arc<ValidatedWorkerSnapshot>>,
    pub(super) candidate: Arc<ValidatedWorkerSnapshot>,
    pub(super) binding: PolicyBinding,
    pub(super) published: bool,
    pub(super) installed: bool,
}
/// Constructed only by the actual prepared receipt acknowledgement path. The
/// live token originates in a real retained handle, never in parsed DATA.
pub(super) struct PolicyAckFence {
    gate: Weak<Inner>,
    owner: Weak<AtomicBool>,
    candidate: EffectiveWorkerConfig,
    binding: PolicyBinding,
}
impl RetainedPreparation {
    pub(super) fn record_policy_ack(
        &mut self,
        record: &reservation_policy::PreparedPolicyRecord,
    ) -> Result<()> {
        let phase = self.policy.as_ref().ok_or(GateError::Refused(
            "RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED",
        ))?;
        need(
            self.journal_available()
                && phase.published
                && phase.installed
                && self.live.load(Ordering::Acquire),
            "RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED",
        )?;
        let gate = self.gate.clone();
        let active = gate.held(Some(&gate.scope))?;
        let fence = Arc::new(PolicyAckFence {
            gate: Arc::downgrade(&gate),
            owner: Arc::downgrade(&self.live),
            candidate: phase.candidate.configuration().clone(),
            binding: phase.binding.clone(),
        });
        {
            let mut slot = active
                .policy_ack
                .lock()
                .map_err(|_| GateError::Refused("RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED"))?;
            need(slot.is_none(), "RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED")?;
            *slot = Some(fence.clone());
        }
        let result = self.journal_record_ack(
                reverie_core::operations::Effect::Prepare,
                record.digest().clone(),
                self.view.record().data().version,
            );
        let closed = match active.policy_ack.lock() {
            Ok(mut slot) => {
                let owned = slot
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &fence));
                slot.take();
                need(owned, "RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED")
            }
            Err(poison) => {
                poison.into_inner().take();
                Err(GateError::Refused(
                    "RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED",
                ))
            }
        };
        self.view = finalized(result, closed)?;
        Ok(())
    }
    pub(super) fn expected_live_configuration(&self) -> &EffectiveWorkerConfig {
        self.policy
            .as_ref()
            .filter(|phase| phase.installed)
            .map_or(self.source_configuration(), |phase| {
                phase.candidate.configuration()
            })
    }
    pub(super) fn assert_policy_current(&self) -> Result<()> {
        let Some(phase) = &self.policy else {
            return Ok(());
        };
        let expected = if phase.published {
            phase.candidate.configuration()
        } else {
            self.source_configuration()
        };
        validate_bound_policy(&phase.binding, expected)?;
        need(
            self.journal_available(),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED",
        )
    }
}
pub(super) fn validate_bound_policy(
    binding: &PolicyBinding,
    expected: &EffectiveWorkerConfig,
) -> Result<()> {
    let metadata = binding.read_for_validation()?;
    let config = reservation_policy::configuration_for_validation(&metadata)?;
    let actual = crate::worker_validation::validate_captured(config)?;
    need(
        worker_config::equivalent(actual.configuration(), expected),
        "RESOURCE_PREPARATION_CONFIG_CHANGED",
    )?;
    binding.assert_named_current().map_err(Into::into)
}
impl Inner {
    pub(super) fn assert_policy_ack(self: &Arc<Self>) -> Result<()> {
        let active = self.held(None)?;
        let fence = active
            .policy_ack
            .lock()
            .map_err(|_| GateError::Refused("RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED"))?
            .clone();
        let Some(fence) = fence else { return Ok(()) };
        need(
            fence
                .gate
                .upgrade()
                .is_some_and(|gate| Arc::ptr_eq(&gate, self))
                && fence
                    .owner
                    .upgrade()
                    .is_some_and(|owner| owner.load(Ordering::Acquire))
                && worker_config::equivalent(self.config()?.configuration(), &fence.candidate),
            "RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED",
        )?;
        self.native_context()?
            .custody_policy(&fence.binding, None)?;
        validate_bound_policy(&fence.binding, &fence.candidate)?;
        need(
            fence
                .owner
                .upgrade()
                .is_some_and(|owner| owner.load(Ordering::Acquire)),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED",
        )
    }
}
