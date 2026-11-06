use super::*;
use reverie_core::ids::ProfileEmployeeId;
/// Read-only cold observations; unavailable/changed source facts retain every
/// claim. No handle, start boundary or completion proof is reconstructed.
/// Structural company projection failures propagate; they are not an ordinary
/// unavailable-source observation in the legacy recovery catch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeObservationState {
    Matches,
    Changed,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryObservation {
    pub operation: JournalId,
    pub native: NativeObservationState,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryFacts {
    recovery_required: bool,
    fenced_sessions: Vec<JournalId>,
    observations: Vec<RecoveryObservation>,
}
impl RecoveryFacts {
    pub fn recovery_required(&self) -> bool {
        self.recovery_required
    }
    pub fn retry_allowed(&self) -> bool {
        false
    }
    pub fn reservation_retained(&self) -> bool {
        true
    }
    pub fn fenced_sessions(&self) -> &[JournalId] {
        &self.fenced_sessions
    }
    pub fn observations(&self) -> &[RecoveryObservation] {
        &self.observations
    }
}
impl ReservationGate {
    pub fn cold_inspect(&self) -> Result<RecoveryFacts> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let result = self.inner.check_recovery();
        admission.conclude(result)
    }
}
impl Inner {
    fn check_recovery(self: &Arc<Self>) -> Result<RecoveryFacts> {
        let document = self.document()?;
        let active = self.active_operations(&document)?;
        let mut observations = Vec::new();
        for operation in &active {
            let op = operation.data();
            let eid = ProfileEmployeeId::parse(op.request.employee_id.as_str())
                .expect("checked journal UUID");
            let native = match self.observe(&op.scope, &op.request.pool_id, &eid) {
                Ok(value) if value.matches_journal(&op.observation) => {
                    NativeObservationState::Matches
                }
                Ok(_) => NativeObservationState::Changed,
                Err(error) if structural_company_error(&error) => return Err(error),
                Err(_) => NativeObservationState::Unavailable,
            };
            // Unavailability is not a reason to skip mandatory custody/scope
            // checks or to strand an unrelated existing transport indefinitely.
            self.guard(None)?;
            observations.push(RecoveryObservation {
                operation: op.id.clone(),
                native,
            });
        }
        need(
            self.document()? == document,
            "RESERVATION_JOURNAL_CHANGED_DURING_RECOVERY",
        )?;
        let mut fenced_sessions = active
            .iter()
            .map(|op| op.data().reserved_sid.clone())
            .collect::<Vec<_>>();
        fenced_sessions.sort();
        Ok(RecoveryFacts {
            recovery_required: !active.is_empty(),
            fenced_sessions,
            observations,
        })
    }
}
fn structural_company_error(error: &GateError) -> bool {
    match error {
        GateError::ObservationData(
            reverie_contracts::reservation_observation::ObservationDataError::CompanyStructure,
        ) => true,
        GateError::Finalization { primary, secondary } => {
            structural_company_error(primary) || structural_company_error(secondary)
        }
        GateError::ClaimUncertain { cause } => structural_company_error(cause),
        _ => false,
    }
}
