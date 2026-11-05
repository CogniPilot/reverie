use super::*;
use crate::revision::ProfileVersion;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationState {
    Reserved,
    Preparing,
    Prepared,
    Starting,
    Started,
    Verifying,
    VerifyRecorded,
    RecoveryRequired,
    Completed,
}
impl OperationState {
    pub fn name(self) -> &'static str {
        match self {
            Self::Reserved => "RESERVED",
            Self::Preparing => "PREPARING",
            Self::Prepared => "PREPARED",
            Self::Starting => "STARTING",
            Self::Started => "STARTED",
            Self::Verifying => "VERIFYING",
            Self::VerifyRecorded => "VERIFY_RECORDED",
            Self::RecoveryRequired => "RECOVERY_REQUIRED",
            Self::Completed => "COMPLETED",
        }
    }
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "RESERVED" => Ok(Self::Reserved),
            "PREPARING" => Ok(Self::Preparing),
            "PREPARED" => Ok(Self::Prepared),
            "STARTING" => Ok(Self::Starting),
            "STARTED" => Ok(Self::Started),
            "VERIFYING" => Ok(Self::Verifying),
            "VERIFY_RECORDED" => Ok(Self::VerifyRecorded),
            "RECOVERY_REQUIRED" => Ok(Self::RecoveryRequired),
            "COMPLETED" => Ok(Self::Completed),
            _ => Err(OperationError::new("STATE")),
        }
    }
    fn phase(self) -> Option<u64> {
        match self {
            Self::Reserved => Some(1),
            Self::Preparing => Some(2),
            Self::Prepared => Some(3),
            Self::Starting => Some(4),
            Self::Started => Some(5),
            Self::Verifying => Some(6),
            Self::VerifyRecorded => Some(7),
            Self::Completed => Some(8),
            Self::RecoveryRequired => None,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Effect {
    Prepare,
    Start,
    Verify,
}
impl Effect {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "prepare" => Ok(Self::Prepare),
            "start" => Ok(Self::Start),
            "verify" => Ok(Self::Verify),
            _ => Err(OperationError::new("EFFECT")),
        }
    }
    fn states(self) -> (OperationState, OperationState, OperationState) {
        use OperationState::*;
        match self {
            Self::Prepare => (Reserved, Preparing, Prepared),
            Self::Start => (Prepared, Starting, Started),
            Self::Verify => (Started, Verifying, VerifyRecorded),
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationData {
    pub id: JournalId,
    pub scope: OperationScope,
    pub idempotency_key: JournalId,
    pub request: OperationRequest,
    pub request_digest: JournalDigest,
    pub reservation_id: JournalId,
    pub reserved_sid: JournalId,
    pub observation: CapacityObservation,
    pub delta_bytes: u64,
    pub version: ProfileVersion,
    pub state: OperationState,
    pub last_receipt_digest: Option<JournalDigest>,
    pub reason: Option<RecoveryReason>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Operation(OperationData);
impl Operation {
    /// Hash relations are separately checked by the named canonical codec.
    pub fn try_new(data: OperationData) -> Result<Self> {
        let observed = data.observation.data();
        let request = &data.request;
        validate_roles(
            &data.id,
            &data.reservation_id,
            &data.reserved_sid,
            &observed.current_sid,
        )?;
        validate_binding(request, &data.observation)?;
        validate_delta(
            request.requested_memory_bytes,
            observed.current_memory_bytes,
            data.delta_bytes,
        )?;
        validate_phase_shape(
            data.state,
            data.version,
            data.last_receipt_digest.is_some(),
            data.reason.is_some(),
        )?;
        Ok(Self(data))
    }
    pub fn data(&self) -> &OperationData {
        &self.0
    }
    pub fn begin(&self, effect: Effect) -> Result<Self> {
        let (before, pending, _) = effect.states();
        need(
            self.0.state == before,
            "EFFECT_ALREADY_ATTEMPTED_OR_OUT_OF_ORDER",
        )?;
        self.changed(pending, None, None)
    }
    pub fn acknowledge(&self, effect: Effect, receipt: JournalDigest) -> Result<Self> {
        let (_, pending, after) = effect.states();
        need(self.0.state == pending, "UNEXPECTED_ACK")?;
        self.changed(after, Some(receipt), None)
    }
    pub fn uncertain(&self, reason: RecoveryReason) -> Result<Self> {
        self.changed(
            OperationState::RecoveryRequired,
            self.0.last_receipt_digest.clone(),
            Some(reason),
        )
    }
    /// Pure candidate only. A store must require its fixed native producer proof
    /// before publishing this data; hashes and state values grant no authority.
    pub fn completion_candidate(&self, receipt: JournalDigest) -> Result<Self> {
        need(
            self.0.state == OperationState::VerifyRecorded && self.0.version.get() == 7,
            "NATIVE_COMPLETION_PHASE",
        )?;
        self.changed(OperationState::Completed, Some(receipt), None)
    }
    fn changed(
        &self,
        state: OperationState,
        receipt: Option<JournalDigest>,
        reason: Option<RecoveryReason>,
    ) -> Result<Self> {
        let mut data = self.0.clone();
        data.version = data
            .version
            .checked_next()
            .map_err(|_| OperationError::new("VERSION"))?;
        data.state = state;
        data.last_receipt_digest = receipt;
        data.reason = reason;
        Self::try_new(data)
    }
}
pub fn validate_roles(
    id: &JournalId,
    reservation: &JournalId,
    target: &JournalId,
    current: &JournalId,
) -> Result<()> {
    need(
        id != reservation && id != target && reservation != target && target != current,
        "RESERVATION_ROLES",
    )
}
pub fn validate_binding(
    request: &OperationRequest,
    observation: &CapacityObservation,
) -> Result<()> {
    let observed = observation.data();
    need(
        request.employee_id == observed.employee_id
            && request.pool_id == observed.pool_id
            && request.source_binding_digest == observed.source_binding_digest
            && request.profile_version == observed.profile_version,
        "OBSERVATION_BINDING",
    )
}
pub fn validate_delta(requested: MemoryBytes, current: MemoryBytes, delta: u64) -> Result<()> {
    need(
        delta == requested.get().saturating_sub(current.get()),
        "DELTA",
    )
}
/// Validate shape before a codec parses optional lexical references, preserving
/// the existing phase-first refusal for a receipt or reason that is forbidden.
pub fn validate_phase_shape(
    state: OperationState,
    version: ProfileVersion,
    has_receipt: bool,
    has_reason: bool,
) -> Result<()> {
    if let Some(expected) = state.phase() {
        need(version.get() == expected, "PHASE_VERSION")?;
        let acknowledged = matches!(
            state,
            OperationState::Prepared
                | OperationState::Started
                | OperationState::VerifyRecorded
                | OperationState::Completed
        );
        need(has_receipt == acknowledged, "PHASE_RECEIPT")?;
        need(!has_reason, "PHASE_REASON")?;
    } else {
        need(version.get() >= 2 && has_reason, "RECOVERY_REASON")?;
    }
    Ok(())
}
