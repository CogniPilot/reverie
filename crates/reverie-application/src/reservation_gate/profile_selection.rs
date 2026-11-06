//! Actual pre-approval canonical RAM choice. Only memory is caller intent;
//! every identity, remaining resource and CAS value comes from current trusted
//! metadata/configuration. This is neither a capacity hold nor a policy reload.
use super::*;
use reverie_contracts::{
    reservation_observation::{ClaimEmployee, ObservationDataError},
    resource_config::checked_effective_policy,
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    profiles::{ProfileBinding, ProfilePutIntent},
    resources::{BudgetMode, ResourcePolicy},
    revision::ObservedProfileVersion,
};
use reverie_store::{
    operations::allocate_profile_target,
    profiles::ProfileStore,
    storage_identity::{self, StorageKind},
};
impl ReservationGate {
    /// Pre-approval selection followed by the same fixed preview transaction.
    /// If a later preview fails, a successful canonical profile CAS is retained
    /// exactly as before; no hidden rollback, hold or native effect is supplied.
    pub fn draft(
        &self,
        employee: &JournalId,
        key: &JournalId,
        memory_mib: Option<u32>,
    ) -> Result<DraftPreview> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let result = (|| {
            if let Some(memory) = memory_mib {
                self.inner.select_profile(employee, memory)?;
            }
            self.inner.draft_profile(employee, key)
        })();
        match result {
            Ok((preview, terminal)) => finalized(Ok(preview), admission.finish_claim(&terminal)),
            Err(error) => admission.conclude(Err(error)),
        }
    }
}
impl Inner {
    fn select_profile(self: &Arc<Self>, employee: &JournalId, memory: u32) -> Result<()> {
        need(
            (512..=1_048_576).contains(&memory),
            "RESOURCE_PREPARATION_RAM_REQUEST",
        )?;
        let history = self.document()?;
        need(
            !self
                .active_operations(&history)?
                .iter()
                .any(|op| op.data().request.employee_id == *employee),
            "RESOURCE_PREPARATION_EMPLOYEE_CLAIM_RETAINED",
        )?;
        let rows = self.guard(None)?;
        let company = storage_identity::read_company_metadata(&self.identity)?;
        let eid = ProfileEmployeeId::parse(employee.as_str()).expect("checked canonical role");
        let selected = ClaimEmployee::capture(&company, &eid).map_err(|error| match error {
            ObservationDataError::CurrentEmployee => {
                GateError::Refused("RESOURCE_PREPARATION_CURRENT_EMPLOYEE_REQUIRED")
            }
            other => other.into(),
        })?;
        let sid = selected.selection_session()?;
        let generation = selected.selection_generation()?;
        need(
            selected.selection_intent(&self.scope)?,
            "RESOURCE_PREPARATION_CURRENT_EMPLOYEE_REQUIRED",
        )?;
        let paths = storage_identity::storage_paths(&self.identity, &sid)?;
        need(
            paths.kind() == StorageKind::Employee
                && paths.identity() == eid.as_str()
                && storage_identity::storage_start_allowed(&self.identity, &paths)?,
            "RESOURCE_PREPARATION_CURRENT_EMPLOYEE_REQUIRED",
        )?;
        let current =
            crate::resource_staging::effective_config(self.config.configuration().clone(), &sid)?;
        let current = checked_effective_policy(&current)?;
        let resources = ResourcePolicy::try_new(
            current.budget_mode(),
            memory,
            current.pids_limit(),
            current.cpus(),
            current.pool_memory_mib(),
            current.pool_tasks_max(),
        )?;
        need(
            resources.budget_mode() == BudgetMode::Admission,
            "RESOURCE_PREPARATION_ADMISSION_REQUIRED",
        )?;
        let target = allocate_profile_target()?;
        let target = ProfileSessionId::parse(target.as_str()).expect("checked new role");
        need(
            target != sid && !history.role_ids().any(|id| id.as_str() == target.as_str()),
            "RESOURCE_PREPARATION_DRAFT_IDS",
        )?;
        need(
            self.target_is_unpublished(&target)? && self.target_is_absent(&rows, &target)?,
            "RESOURCE_PREPARATION_DRAFT_IDS",
        )?;
        let profiles = ProfileStore::open(reservation_control::profile_directory(&self.config)?)?;
        let result = (|| {
            let snapshot = profiles.snapshot()?;
            let old = snapshot.profiles().get(&eid);
            need(
                !snapshot.profiles().values().any(|profile| {
                    profile.binding().current_session() == &target
                        || profile.binding().target_session() == &target
                }),
                "RESOURCE_PREPARATION_DRAFT_IDS",
            )?;
            need(
                self.guard(None)?.equivalent(&rows)
                    && storage_identity::read_company_metadata(&self.identity)?
                        .equivalent(&company)
                    && storage_identity::storage_paths(&self.identity, &sid)? == paths,
                "RESOURCE_PREPARATION_SOURCE_CHANGED",
            )?;
            // Validate the target generation at the original late put phase,
            // after final native/company/storage fences, not before them.
            let binding = ProfileBinding::try_new(
                eid.clone(),
                sid,
                target,
                generation,
                generation.checked_next()?,
            )?;
            let expected =
                ObservedProfileVersion::try_new(old.map_or(0, |profile| profile.version().get()))?;
            let intent = ProfilePutIntent::try_new(
                eid,
                resources,
                binding,
                snapshot.revision(),
                expected,
                old.map(|profile| profile.binding().clone()),
            )
            .map_err(reverie_store::StoreError::Profile)?;
            profiles.put(&intent)?;
            Ok(())
        })();
        finalized(result, profiles.close().map_err(Into::into))
    }
}
