//! RAM-purpose preview keeps the legacy Admission profile and derives a
//! separate target policy from the same real native source. No claim is minted.
use super::*;
use crate::installing_broker::resource_actor::AuthenticatedResourceOperation;
use reverie_contracts::{
    ram_migration::RamMigrationPolicy,
    reservation_observation::{ClaimEmployee, ReservationObservation},
    resource_actor::ResourceRequestSelection,
};
use reverie_core::profiles::ResourceProfile;
use reverie_store::storage_identity;

pub(super) type ObservedRamDraft = (
    DraftPreview,
    super::claim::TerminalClaim,
    Option<RamMigrationPolicy>,
);

pub struct RamDraftPreview {
    preview: DraftPreview,
    policy: RamMigrationPolicy,
}
impl RamDraftPreview {
    pub fn preview(&self) -> &DraftPreview {
        &self.preview
    }
    pub fn policy(&self) -> &RamMigrationPolicy {
        &self.policy
    }
}

pub(super) struct RamPreviewGuard<'a, 'q> {
    gate: &'a ReservationGate,
    operation: &'a AuthenticatedResourceOperation<'q>,
}
impl RamPreviewGuard<'_, '_> {
    pub(super) fn check_profile(
        &self,
        resources: &reverie_core::resources::ResourcePolicy,
    ) -> Result<()> {
        let ResourceRequestSelection::Preview {
            requested_memory_mib,
            ..
        } = self.operation.request().selection()
        else {
            return Err(GateError::Refused("RESOURCE_RAM_PREVIEW_REQUIRED"));
        };
        need(
            resources.memory_mib() == *requested_memory_mib
                && resources.memory_mib() != 0
                && resources.memory_mib() == resources.pool_memory_mib()
                && resources.cpus().nano_cpus() == 0,
            "RAM_MIGRATION_BURST_POOL_REQUIRED",
        )
    }
    pub(super) fn check(&self, inner: &Arc<Inner>) -> Result<()> {
        need(
            Arc::ptr_eq(&self.gate.inner, inner),
            "RESOURCE_ACTOR_GATE_CHANGED",
        )?;
        self.operation
            .assert_reservation_gate(self.gate)
            .map_err(|error| GateError::Refused(error.code()))?;
        let current = self
            .operation
            .current_owner()
            .map_err(|error| GateError::Refused(error.code()))?;
        storage_identity::read_company_metadata(&inner.identity)?
            .require_resource_owner(self.operation.request().employee_id(), current.owner())
            .map_err(|error| GateError::Refused(error.code()))?;
        self.operation
            .assert_live()
            .map_err(|error| GateError::Refused(error.code()))
    }
    pub(super) fn observe_policy(
        &self,
        inner: &Arc<Inner>,
        profile: &ResourceProfile,
        rows: &ObservedInventory,
        observed: &ReservationObservation,
    ) -> Result<RamMigrationPolicy> {
        self.check(inner)?;
        let binding = profile.binding();
        let paths = storage_identity::storage_paths(&inner.identity, binding.current_session())?;
        let native = inner.native_context()?;
        let (row, limits) = inner.source_row(&native, rows, &paths, binding.employee())?;
        let storage = native.storage(&row, &paths)?;
        let employee = ClaimEmployee::capture(
            &storage_identity::read_company_metadata(&inner.identity)?,
            binding.employee(),
        )?;
        need(
            reverie_contracts::reservation_observation::claim_source_binding_digest(
                &employee, &limits, &storage, profile,
            )? == observed.fields().source_binding,
            "RESOURCE_PREPARATION_SOURCE_CHANGED",
        )?;
        let policy = super::preparation_stage::ram_policy_from_source(
            profile,
            &limits,
            inner.config()?.configuration(),
        )?;
        need(
            inner.guard(None)?.equivalent(rows),
            "RESOURCE_PREPARATION_SOURCE_CHANGED",
        )?;
        self.check(inner)?;
        Ok(policy)
    }
}
impl ReservationGate {
    pub(crate) fn draft_ram_operation(
        &self,
        operation: &AuthenticatedResourceOperation<'_>,
    ) -> Result<RamDraftPreview> {
        let ResourceRequestSelection::Preview {
            employee_id,
            idempotency_key,
            requested_memory_mib,
        } = operation.request().selection()
        else {
            return Err(GateError::Refused("RESOURCE_RAM_PREVIEW_REQUIRED"));
        };
        let employee = JournalId::parse(employee_id.as_str()).expect("canonical employee");
        let authority = RamPreviewGuard {
            gate: self,
            operation,
        };
        authority.check(&self.inner)?;
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let body = (|| {
            authority.check(&self.inner)?;
            self.inner.select_profile_checked(
                &employee,
                *requested_memory_mib,
                Some(&authority),
            )?;
            self.inner
                .draft_profile_checked(&employee, idempotency_key, Some(&authority))
        })();
        match body {
            Ok((preview, terminal, policy)) => {
                let preview = RamDraftPreview {
                    preview,
                    policy: policy.expect("RAM observation is purpose-bound"),
                };
                finalized(Ok(preview), admission.finish_claim(&terminal))
            }
            Err(error) => admission.conclude(Err(error)),
        }
    }
}
