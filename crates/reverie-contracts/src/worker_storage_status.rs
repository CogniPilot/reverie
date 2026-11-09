//! Closed, privacy-safe DATA from original live storage owners. These values
//! grant no release, retry, reconciliation, capacity or process authority.
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOwnerRow {
    pub session_id: String,
    /// Current canonical binding DATA, not the original owner's generation.
    pub current_session_generation: Option<String>,
    pub writer_checked: bool,
    pub owner_kind: OwnerKind,
    pub observation: OwnerObservation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OwnerKind {
    Direct,
    FinalizingReady,
    FinalizingDirect,
    Source,
    StoppedRam,
    Nix,
    Laptop,
    ReplacementStop,
    OrdinaryStop,
    ControlStop,
    ExistingViewer,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OwnerPhase {
    Held,
    Running,
    Known,
    Retained,
    Cleaning,
    FinalizingStarted,
    Stopped,
    CleanupRetained,
    Consumed,
    Starting,
    Viewing,
    Closing,
    Closed,
    Inspecting,
    Policy,
    Stopping,
    Failed,
    Attempted,
    Confirmed,
    UnleasedLegacy,
    ConsumedUnconfirmed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckPhase {
    Unattempted,
    Reading,
    Known,
    Failed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecordedOutcome {
    NotRecorded,
    SuccessRecorded,
    FailureRecorded,
}
/// `native_uncertain: None` means this owner has no complete local classifier.
/// Partial live views report positively recorded pending/uncertainty only;
/// absent local tickets/flags do not classify transitive native subowners.
/// A false pending flag is not proof of resource closure or a successful result.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum OwnerObservation {
    Observed {
        phase: OwnerPhase,
        #[serde(rename = "finalStorageCheck")]
        final_storage_check: Option<CheckPhase>,
        outcome: RecordedOutcome,
        #[serde(rename = "nativePending")]
        native_pending: Option<bool>,
        #[serde(rename = "nativeUncertain")]
        native_uncertain: Option<bool>,
    },
    Busy,
    Poisoned,
}
impl OwnerObservation {
    pub fn observed(
        phase: OwnerPhase,
        outcome: RecordedOutcome,
        native_pending: Option<bool>,
        native_uncertain: Option<bool>,
    ) -> Self {
        Self::Observed {
            phase,
            final_storage_check: None,
            outcome,
            native_pending,
            native_uncertain,
        }
    }
    pub fn with_final_check(mut self, check: CheckPhase) -> Self {
        if let Self::Observed {
            final_storage_check,
            ..
        } = &mut self
        {
            *final_storage_check = Some(check);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_serializes_only_closed_categories_and_distinguishes_unknown() {
        let data = OwnerObservation::observed(
            OwnerPhase::Retained,
            RecordedOutcome::FailureRecorded,
            Some(false),
            None,
        )
        .with_final_check(CheckPhase::Failed);
        assert_eq!(
            serde_json::to_value(data).unwrap(),
            serde_json::json!({
                "state":"observed","phase":"retained","finalStorageCheck":"failed",
                "outcome":"failure-recorded","nativePending":false,"nativeUncertain":null
            })
        );
        assert_eq!(
            serde_json::to_value(OwnerObservation::Busy).unwrap(),
            serde_json::json!({"state":"busy"})
        );
    }
}
