use super::*;
use reverie_contracts::{
    profiles_v1,
    reservation_observation::{ClaimEmployee, ReservationObservation},
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::{CapacityObservation, OperationDocument, OperationRequest, OperationState},
    profiles::ResourceProfile,
};
use reverie_store::{
    operations::{CapacityObserver, ClaimSelection, OperationHandle},
    storage_identity::{self, StorageKind},
};

/// Private installed observer context. Approved profile DATA is read internally
/// under the actual admission; callers cannot supply this type or a callback.
struct ClaimCapacity {
    gate: Weak<Inner>,
    approved: ResourceProfile,
    native: Mutex<Option<ObservedInventory>>,
}
pub(super) struct TerminalClaim {
    pub(super) profile: ResourceProfile,
    pub(super) employee: ClaimEmployee,
    pub(super) document: OperationDocument,
    pub(super) native: ObservedInventory,
    pub(super) observed: ReservationObservation,
}
pub(super) struct ClaimedContext {
    pub(super) view: OperationView,
    pub(super) handle: Option<OperationHandle>,
    pub(super) terminal: TerminalClaim,
    pub(super) store: OperationStore,
}
impl CapacityObserver for ClaimCapacity {
    fn observe(
        &self,
        scope: &OperationScope,
        pool: &JournalId,
        employee: &JournalId,
    ) -> std::result::Result<CapacityObservation, JournalError> {
        let result = (|| {
            let gate = self
                .gate
                .upgrade()
                .ok_or(GateError::Refused("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
            let eid = ProfileEmployeeId::parse(employee.as_str()).expect("checked journal UUID");
            let (observed, native) = gate.observe_claim(scope, pool, &eid, &self.approved)?;
            let observed = observed.journal_data()?;
            *self
                .native
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))? =
                Some(native);
            Ok(observed)
        })();
        result.map_err(|error: GateError| JournalError::guard_failure(error.code(), error))
    }
}
impl ReservationGate {
    /// Private installing-service metadata reservation. The effect handle is
    /// discarded; this entry cannot retain or create preparation/start owners.
    pub fn reserve(&self, key: &JournalId, request: &OperationRequest) -> Result<OperationView> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let mut claimed = false;
        let body = self.inner.reserve_metadata(key, request, &mut claimed);
        let result = match body {
            Ok((view, terminal)) => finalized(Ok(view), admission.finish_claim(&terminal)),
            Err(error) => admission.conclude(Err(error)),
        };
        if claimed {
            result.map_err(|error| match error {
                GateError::Journal(error) if error.is_uncertain() => GateError::Journal(error),
                other => GateError::ClaimUncertain {
                    cause: Box::new(other),
                },
            })
        } else {
            result
        }
    }
}
impl Inner {
    fn reserve_metadata(
        self: &Arc<Self>,
        key: &JournalId,
        request: &OperationRequest,
        claimed: &mut bool,
    ) -> Result<(OperationView, TerminalClaim)> {
        let claimed =
            self.claim_reservation(key, request, ClaimSelection::default(), None, claimed)?;
        finalized(
            Ok((claimed.view, claimed.terminal)),
            claimed.store.close().map_err(Into::into),
        )
    }
    pub(super) fn claim_reservation(
        self: &Arc<Self>,
        key: &JournalId,
        request: &OperationRequest,
        mut selected: ClaimSelection,
        draft: Option<&reverie_contracts::reservation_draft::DraftRecord>,
        claimed: &mut bool,
    ) -> Result<ClaimedContext> {
        self.require_host_job_idle()?;
        let history = self.document()?;
        need(
            !self
                .active_operations(&history)?
                .iter()
                .any(|op| op.data().state == OperationState::Completed),
            "RESOURCE_COMPLETION_PENDING_RECONCILIATION",
        )?;
        let eid =
            ProfileEmployeeId::parse(request.employee_id.as_str()).expect("checked journal UUID");
        let observed = self.observe(&self.scope, &request.pool_id, &eid)?;
        let profile = self
            .profile(&eid)?
            .ok_or(GateError::Refused("RESERVATION_REQUEST_PROFILE"))?;
        let memory = u64::from(profile.resources().memory_mib()) * reverie_core::operations::MIB;
        let matches = match draft {
            Some(record) => record.requested_memory_matches(memory)?,
            None => request.requested_memory_bytes.get() == memory,
        };
        need(matches, "RESERVATION_REQUEST_PROFILE")?;
        need(
            request.observation_digest == observed.digest(),
            "STALE_CAPACITY_SNAPSHOT",
        )?;
        let employee = ClaimEmployee::capture(
            &storage_identity::read_company_metadata(&self.identity)?,
            &eid,
        )?;
        let capacity = Arc::new(ClaimCapacity {
            gate: Arc::downgrade(self),
            approved: profile.clone(),
            native: Mutex::new(None),
        });
        let store = self.claim_store(capacity.clone())?;
        let result = (|| {
            let request = match draft {
                Some(record) => record.request()?,
                None => request.clone(),
            };
            selected.reserved_sid = Some(JournalId::parse(
                profile.binding().target_session().as_str(),
            )?);
            let (view, handle) = store.claim(&self.scope, key, &request, &selected)?;
            *claimed = true;
            let document = store.confirm_claim(&self.scope, &view)?;
            let native = capacity
                .native
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
                .take()
                .ok_or(GateError::Refused(
                    "RESERVATION_TARGET_NATIVE_BINDING_CHANGED",
                ))?;
            Ok((
                view,
                handle,
                TerminalClaim {
                    profile,
                    employee,
                    document,
                    native,
                    observed,
                },
            ))
        })();
        match result {
            Ok((view, handle, terminal)) => Ok(ClaimedContext {
                view,
                handle,
                terminal,
                store,
            }),
            Err(error) => finalized(Err(error), store.close().map_err(Into::into)),
        }
    }
    fn claim_store(self: &Arc<Self>, observer: Arc<ClaimCapacity>) -> Result<OperationStore> {
        Ok(OperationStore::open(
            reservation_control::operation_directory(&self.config)?,
            super::guard::installed(self),
            Some(observer),
        )?)
    }
    pub(super) fn observe_claim(
        &self,
        scope: &OperationScope,
        pool: &JournalId,
        eid: &ProfileEmployeeId,
        approved: &ResourceProfile,
    ) -> Result<(ReservationObservation, ObservedInventory)> {
        let observed = self.observe(scope, pool, eid)?;
        need(
            self.profile(eid)?
                .as_ref()
                .is_some_and(|profile| profiles_v1::equivalent(profile, approved)),
            "RESERVATION_APPROVED_PROFILE_CHANGED",
        )?;
        let binding = approved.binding();
        need(
            binding.current_session() == &observed.fields().current_session
                && binding.current_generation() == observed.fields().generation
                && binding.current_generation().get().checked_add(1)
                    == Some(binding.target_generation().get())
                && binding.target_session() != &observed.fields().current_session,
            "RESERVATION_APPROVED_TARGET_REQUIRED",
        )?;
        self.target_unpublished(binding.target_session())?;
        let native = self.native_context()?;
        let before = native.inventory(None)?;
        self.target_absent(&before, binding.target_session())?;
        need(
            self.profile(eid)?
                .as_ref()
                .is_some_and(|profile| profiles_v1::equivalent(profile, approved)),
            "RESERVATION_APPROVED_PROFILE_CHANGED",
        )?;
        let after = native.inventory(None)?;
        need(
            after.equivalent(&before),
            "RESERVATION_TARGET_NATIVE_BINDING_CHANGED",
        )?;
        need(
            self.profile(eid)?
                .as_ref()
                .is_some_and(|profile| profiles_v1::equivalent(profile, approved)),
            "RESERVATION_APPROVED_PROFILE_CHANGED",
        )?;
        self.target_unpublished(binding.target_session())?;
        Ok((observed, after))
    }
    pub(super) fn target_absent(
        &self,
        rows: &ObservedInventory,
        target: &ProfileSessionId,
    ) -> Result<()> {
        need(
            self.target_is_absent(rows, target)?,
            "RESERVATION_TARGET_ALREADY_PUBLISHED",
        )
    }
    pub(super) fn target_is_absent(
        &self,
        rows: &ObservedInventory,
        target: &ProfileSessionId,
    ) -> Result<bool> {
        for row in rows.rows() {
            if row.data().label_is("reverie.session", target.as_str())? {
                return Ok(false);
            }
        }
        Ok(true)
    }
    pub(super) fn target_unpublished(&self, target: &ProfileSessionId) -> Result<()> {
        need(
            self.target_is_unpublished(target)?,
            "RESERVATION_TARGET_ALREADY_PUBLISHED",
        )
    }
    pub(super) fn target_is_unpublished(&self, target: &ProfileSessionId) -> Result<bool> {
        let paths = storage_identity::storage_paths(&self.identity, target)?;
        Ok(paths.kind() == StorageKind::Session
            && paths.identity() == target.as_str()
            && !reservation_control::session_directory_present(&self.config, target)?)
    }
}
