use super::claim::TerminalClaim;
use super::*;
use reverie_contracts::{
    reservation_draft::{self, DraftFields, DraftRecord},
    reservation_observation::{ClaimEmployee, ReservationObservation},
};
use reverie_core::{
    capacity::{CapacityCounter, pool_headroom_fits},
    ids::ProfileEmployeeId,
    operations::{JournalDigest, OperationDocument},
    profiles::ResourceProfile,
};
use reverie_store::{
    operations::{DraftObservation, DraftObserver, allocate_draft_references},
    storage_identity,
};

/// Immutable persisted preview DATA. No journal lease or native execution
/// permission is retained by this response.
pub struct DraftPreview {
    record: DraftRecord,
    profile: ResourceProfile,
    source_memory_mib: u64,
}
impl DraftPreview {
    pub fn draft_id(&self) -> JournalId {
        self.record.id()
    }
    pub fn operation_id(&self) -> JournalId {
        self.record.operation()
    }
    pub fn reservation_id(&self) -> JournalId {
        self.record.reservation()
    }
    pub fn target_session(&self) -> JournalId {
        self.record.target()
    }
    pub fn digest(&self) -> JournalDigest {
        self.record.digest().expect("checked finite preview")
    }
    pub fn profile(&self) -> &ResourceProfile {
        &self.profile
    }
    pub fn source_memory_mib(&self) -> u64 {
        self.source_memory_mib
    }
    pub fn capacity_held(&self) -> bool {
        false
    }
    pub fn native_effects(&self) -> bool {
        false
    }
}
struct DraftCapacity {
    gate: Weak<Inner>,
    employee: ProfileEmployeeId,
    key: JournalId,
    approved: Mutex<Option<ResourceProfile>>,
    captured: Mutex<Option<(DraftRecord, ObservedInventory)>>,
}
impl DraftObserver for DraftCapacity {
    fn observe_draft(
        &self,
        scope: &OperationScope,
        document: &OperationDocument,
    ) -> std::result::Result<DraftObservation, JournalError> {
        let result = (|| {
            let gate = self
                .gate
                .upgrade()
                .ok_or(GateError::Refused("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
            let approved = self
                .approved
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
                .clone()
                .ok_or(GateError::Refused("RESOURCE_PREPARATION_PROFILE_MISSING"))?;
            let (observation, native) =
                gate.observe_claim(scope, gate.option.pool(), &self.employee, &approved)?;
            // Called directly with the canonical locked document. Opening a
            // second store here would violate the original flock/I/O order.
            let retained_bytes = gate.retained_delta(document)?;
            check_capacity(&observation, &retained_bytes, &approved)?;
            // Allocation is deliberately after all observation/capacity reads.
            let ids = allocate_draft_references()?;
            let record = DraftRecord::from_observed_data(
                DraftFields {
                    draft: &ids.draft,
                    key: &self.key,
                    operation: &ids.operation,
                    reservation: &ids.reservation,
                    scope,
                    profile: &approved,
                    observed: &observation,
                },
                document,
            )?;
            *self
                .captured
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))? =
                Some((record, native));
            Ok(DraftObservation {
                observation,
                retained_bytes,
            })
        })();
        result.map_err(|error: GateError| JournalError::guard_failure(error.code(), error))
    }
}
fn check_capacity(
    observed: &ReservationObservation,
    retained: &reverie_core::decimal::UnsignedInteger,
    profile: &ResourceProfile,
) -> Result<()> {
    let fields = observed.fields();
    let candidate = (u64::from(profile.resources().memory_mib()) * reverie_core::operations::MIB)
        .saturating_sub(fields.current_memory.get());
    need(
        pool_headroom_fits(
            CapacityCounter::try_new(fields.budget_bytes)?,
            CapacityCounter::try_new(fields.committed_bytes)?,
            CapacityCounter::from_integer(retained)?,
            CapacityCounter::try_new(candidate)?,
        )?,
        "RESOURCE_PREPARATION_DRAFT_CAPACITY",
    )
}
impl ReservationGate {
    /// Preview the already selected canonical profile through the actual
    /// admission, journal reader/flock and fixed native observers. This does
    /// not select a replacement profile, claim capacity or create an effect.
    pub fn draft_approved_profile(
        &self,
        employee: &JournalId,
        key: &JournalId,
    ) -> Result<DraftPreview> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
        match self.inner.draft_profile(employee, key) {
            Ok((preview, terminal)) => finalized(Ok(preview), admission.finish_claim(&terminal)),
            Err(error) => admission.conclude(Err(error)),
        }
    }
}
impl Inner {
    fn draft_profile(
        self: &Arc<Self>,
        employee: &JournalId,
        key: &JournalId,
    ) -> Result<(DraftPreview, TerminalClaim)> {
        // The source opens its ordinary store before the profile snapshot.
        let eid = ProfileEmployeeId::parse(employee.as_str()).expect("checked UUID");
        let capacity = Arc::new(DraftCapacity {
            gate: Arc::downgrade(self),
            employee: eid.clone(),
            key: key.clone(),
            approved: Mutex::new(None),
            captured: Mutex::new(None),
        });
        let store = OperationStore::open_draft(
            reservation_control::operation_directory(&self.config)?,
            super::guard::installed(self),
            capacity.clone(),
        )?;
        let body = (|| {
            let profile = self
                .profile(&eid)?
                .ok_or(GateError::Refused("RESOURCE_PREPARATION_PROFILE_MISSING"))?;
            *capacity
                .approved
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))? =
                Some(profile.clone());
            Ok((profile, store.observe_draft(&self.scope)?))
        })();
        let (profile, snapshot) = finalized(body, store.close().map_err(Into::into))?;
        let (document, observed) = snapshot.into_parts();
        let (record, native) = capacity
            .captured
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
            .take()
            .ok_or(GateError::Refused(
                "RESERVATION_TARGET_NATIVE_BINDING_CHANGED",
            ))?;
        reservation_draft::validate_directory_names(&reservation_control::settlement_names(
            &self.config,
        )?)?;
        reservation_control::publish_draft(&self.config, &record)?;
        let employee = ClaimEmployee::capture(
            &storage_identity::read_company_metadata(&self.identity)?,
            &eid,
        )?;
        let source_memory_mib =
            observed.observation.fields().current_memory.get() / reverie_core::operations::MIB;
        Ok((
            DraftPreview {
                record,
                profile: profile.clone(),
                source_memory_mib,
            },
            TerminalClaim {
                profile,
                employee,
                document,
                native,
                observed: observed.observation,
            },
        ))
    }
}
