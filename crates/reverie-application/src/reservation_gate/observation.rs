use super::*;
use crate::{
    reservation_observer::{ObservedRow, WebsiteBinding},
    resource_staging,
};
use reverie_contracts::{
    profiles_v1,
    reservation_engine::NativeLimitBinding,
    reservation_observation::{
        self, ReservationEmployee, ReservationObservation, ReservationObservationFields,
    },
    resource_config::{self, ResourceConfiguration},
    worker_config::policy_digest,
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::MemoryBytes,
    profiles::ResourceProfile,
    resources::BudgetMode,
};
use reverie_store::{
    profiles::ProfileStore,
    storage_identity::{self, StorageKind, StoragePaths},
};

impl Inner {
    pub(super) fn native_context(&self) -> Result<ObservationContext> {
        let active = self.held(None)?;
        let bound = *active
            .deadline
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let context = active
            .context
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        Ok(context.with_inherited(bound))
    }
    pub(super) fn profile(&self, employee: &ProfileEmployeeId) -> Result<Option<ResourceProfile>> {
        let store = ProfileStore::open(reservation_control::profile_directory(
            self.config()?.as_ref(),
        )?)?;
        let read = store.snapshot().map_err(Into::into);
        let document = finalized(read, store.close().map_err(Into::into))?;
        Ok(document.profiles().get(employee).cloned())
    }
    pub(super) fn observe(
        &self,
        scope: &OperationScope,
        pool: &JournalId,
        eid: &ProfileEmployeeId,
    ) -> Result<ReservationObservation> {
        need(
            scope == &self.scope && pool == self.option.pool(),
            "RESERVATION_SCOPE_CHANGED",
        )?;
        let rows = self.guard(Some(scope))?;
        let paths = self.current_paths(eid)?;
        let company = storage_identity::read_company_metadata(&self.identity)?;
        let employee = ReservationEmployee::select(&company, eid, paths.session())?;
        need(
            employee.owner_scope_digest(&self.scope.company_id)? == self.scope.owner_scope_digest,
            "RESERVATION_OWNER_SCOPE",
        )?;
        let generation = employee.generation()?;
        let profile = self
            .profile(eid)?
            .ok_or(GateError::Refused("RESERVATION_PROFILE_MISSING"))?;
        need(
            profile.binding().current_session() == paths.session()
                && profile.binding().current_generation() == generation
                && profile.resources().budget_mode() == BudgetMode::Admission,
            "RESERVATION_PROFILE_BINDING",
        )?;
        let current = resource_staging::effective_config(
            self.config()?.configuration().clone(),
            paths.session(),
        )?;
        let projected = ResourceConfiguration::capture(self.config()?.configuration().clone())?
            .project_profile_policy(profile.resources())?;
        need(
            resource_config::same_non_memory_resources(&projected, &current),
            "RESERVATION_RAM_ONLY_PROFILE",
        )?;
        let native = self.native_context()?;
        let capacity = native.capacity(&rows)?;
        let (row, binding) = self.source_row(&native, &rows, &paths, eid)?;
        need(
            binding
                .resource_ceiling_matches(&resource_config::checked_effective_policy(&current)?)?,
            "RESERVATION_SOURCE_POLICY",
        )?;
        let storage = native.storage(&row, &paths)?;
        let source = reservation_observation::source_binding_digest(
            &employee, &binding, &storage, &profile,
        )?;
        let site = match capacity.website() {
            WebsiteBinding::Running(value) => reservation_observation::PoolWebsite::Running(value),
            WebsiteBinding::Stopped(value) => reservation_observation::PoolWebsite::Stopped(value),
        };
        let epoch = reservation_observation::pool_revision_digest(
            pool,
            capacity.budget(),
            site,
            self.option.host_reserve_mib(),
            capacity.commitments(),
        )?;
        need(
            native.inventory(None)?.equivalent(&rows),
            "RESERVATION_NATIVE_INVENTORY_CHANGED",
        )?;
        self.guard(Some(scope))?;
        self.assert_metadata_current(&employee, &paths, &profile)?;
        ReservationObservation::try_new(ReservationObservationFields {
            pool: pool.clone(),
            pool_revision: epoch,
            budget_bytes: counter(capacity.budget())?,
            committed_bytes: counter(capacity.total())?,
            employee: eid.clone(),
            current_session: paths.session().clone(),
            generation,
            source_binding: source,
            profile_version: profile.version(),
            current_memory: MemoryBytes::try_new(counter(binding.memory())?)?,
        })
        .map_err(Into::into)
    }
    fn current_paths(&self, eid: &ProfileEmployeeId) -> Result<StoragePaths> {
        let company = storage_identity::read_company_metadata(&self.identity)?;
        let session = ReservationEmployee::first_session(&company, eid)?
            .and_then(|value| value.scalar_text())
            .and_then(|value| ProfileSessionId::parse(&value).ok())
            .ok_or(GateError::Refused("CANONICAL_STORAGE_IDENTITY"))?;
        let paths = storage_identity::storage_paths(&self.identity, &session)?;
        need(
            paths.kind() == StorageKind::Employee
                && paths.identity() == eid.as_str()
                && storage_identity::storage_start_allowed(&self.identity, &paths)?,
            "RESERVATION_CURRENT_EMPLOYEE_REQUIRED",
        )?;
        Ok(paths)
    }
    fn source_row<'a>(
        &self,
        native: &ObservationContext,
        rows: &'a ObservedInventory,
        paths: &StoragePaths,
        eid: &ProfileEmployeeId,
    ) -> Result<(ObservedRow<'a>, NativeLimitBinding)> {
        let deployment = self.config()?.deployment()?;
        let name = format!("/{deployment}-agent-{}", paths.session());
        let mut targets = Vec::new();
        for row in rows.rows() {
            let data = row.data();
            if !data.running()? || !data.worker()? {
                continue;
            }
            let binding = native.limits(&row)?;
            if !data.label_is("reverie.worker", &deployment)?
                || !data.label_is("reverie.session", paths.session().as_str())?
            {
                continue;
            }
            need(
                data.label_is("reverie.employee", eid.as_str())? && data.name_is(&name),
                "RESERVATION_SOURCE_POLICY",
            )?;
            let latest = resource_staging::effective_config(
                self.config()?.configuration().clone(),
                paths.session(),
            )?;
            need(
                data.label_is("reverie.worker-policy", &policy_digest(&latest).to_hex())?,
                "RESERVATION_SOURCE_POLICY",
            )?;
            targets.push((row, binding));
        }
        need(targets.len() == 1, "RESERVATION_SOURCE_BINDING")?;
        Ok(targets.pop().expect("exactly one selected source"))
    }
    fn assert_metadata_current(
        &self,
        employee: &ReservationEmployee,
        paths: &StoragePaths,
        profile: &ResourceProfile,
    ) -> Result<()> {
        let company = storage_identity::read_company_metadata(&self.identity)?;
        need(
            employee.still_current(&company)?
                && storage_identity::storage_paths(&self.identity, paths.session())? == *paths
                && storage_identity::storage_start_allowed(&self.identity, paths)?,
            "RESERVATION_EMPLOYEE_CHANGED_DURING_OBSERVATION",
        )?;
        let latest = self.profile(employee.identity())?;
        need(
            latest
                .as_ref()
                .is_some_and(|latest| profiles_v1::equivalent(latest, profile)),
            "RESERVATION_PROFILE_CHANGED_DURING_OBSERVATION",
        )?;
        reservation_control::assert_store_lock_names(self.config()?.as_ref(), &self.binding)?;
        Ok(())
    }
}
fn counter(value: &reverie_core::decimal::UnsignedInteger) -> Result<u64> {
    value
        .as_str()
        .parse()
        .map_err(|_| GateError::Refused("RESERVATION_CAPACITY_EXHAUSTED"))
}
