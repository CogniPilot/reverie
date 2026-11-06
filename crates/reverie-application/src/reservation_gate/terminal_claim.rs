use super::claim::TerminalClaim;
use super::*;
use crate::reservation_observer::WebsiteBinding;
use reverie_contracts::{
    profiles_v1,
    reservation_observation::{self, PoolWebsite},
};
use reverie_store::storage_identity::{self, StorageKind};
impl Inner {
    /// The fresh exact reader closes both owned store and journal flock before
    /// the first terminal native guard. No handle resurrection is performed.
    pub(super) fn finish_claim(self: &Arc<Self>, claim: &TerminalClaim) -> Result<()> {
        let stamp = self
            .store()?
            .into_exact_terminal_stamp(&self.scope, &claim.document)?;
        let rows = self.guard(None)?;
        need(
            rows.equivalent(&claim.native),
            "RESERVATION_TARGET_NATIVE_BINDING_CHANGED",
        )?;
        let native = self.native_context()?;
        let observed = claim.observed.fields();
        let capacity = native.capacity(&rows)?;
        let site = match capacity.website() {
            WebsiteBinding::Running(value) => PoolWebsite::Running(value),
            WebsiteBinding::Stopped(value) => PoolWebsite::Stopped(value),
        };
        let epoch = reservation_observation::pool_revision_digest(
            &observed.pool,
            capacity.budget(),
            site,
            self.option.host_reserve_mib(),
            capacity.commitments(),
        )?;
        need(
            epoch == observed.pool_revision
                && capacity.total().as_str() == observed.committed_bytes.to_string()
                && capacity.budget().as_str() == observed.budget_bytes.to_string(),
            "RESERVATION_CAPACITY_CHANGED",
        )?;
        let binding = claim.profile.binding();
        let paths = storage_identity::storage_paths(&self.identity, binding.current_session())?;
        let deployment = self.config.deployment()?;
        let mut source = None;
        for row in rows.rows() {
            if row.data().label_is("reverie.worker", &deployment)?
                && row
                    .data()
                    .label_is("reverie.session", binding.current_session().as_str())?
            {
                need(source.is_none(), "RESERVATION_SOURCE_BINDING")?;
                source = Some(row);
            }
        }
        let source = source.ok_or(GateError::Refused("RESERVATION_SOURCE_BINDING"))?;
        let limits = native.limits(&source)?;
        let storage = native.storage(&source, &paths)?;
        need(
            reservation_observation::claim_source_binding_digest(
                &claim.employee,
                &limits,
                &storage,
                &claim.profile,
            )? == observed.source_binding,
            "RESERVATION_SOURCE_BINDING_CHANGED",
        )?;
        need(
            self.guard(None)?.equivalent(&rows),
            "RESERVATION_NATIVE_INVENTORY_CHANGED",
        )?;
        stamp.assert_named_current()?;
        self.target_absent(&rows, binding.target_session())?;
        need(
            self.profile(binding.employee())?
                .as_ref()
                .is_some_and(|profile| profiles_v1::equivalent(profile, &claim.profile)),
            "RESERVATION_APPROVED_PROFILE_CHANGED",
        )?;
        need(
            claim
                .employee
                .still_current(&storage_identity::read_company_metadata(&self.identity)?)?,
            "RESERVATION_EMPLOYEE_CHANGED_DURING_OBSERVATION",
        )?;
        let paths = storage_identity::storage_paths(&self.identity, binding.current_session())?;
        need(
            paths.kind() == StorageKind::Employee
                && paths.identity() == binding.employee().as_str()
                && storage_identity::storage_start_allowed(&self.identity, &paths)?,
            "RESERVATION_CURRENT_EMPLOYEE_REQUIRED",
        )?;
        self.target_unpublished(binding.target_session())
    }
}
