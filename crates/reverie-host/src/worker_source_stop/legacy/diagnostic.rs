//! Read-only original ordinary stop attempt, with no CLI or settlement.
use super::*;
use reverie_contracts::worker_storage_status::{
    OwnerObservation as View, OwnerPhase as PhaseView, RecordedOutcome as Outcome,
};
impl OrdinaryStopAttempt {
    pub(super) fn diagnostic(&self) -> View {
        let phase = match self.phase {
            LegacyPhase::Held => PhaseView::Held,
            LegacyPhase::Attempted => PhaseView::Attempted,
            LegacyPhase::Confirmed => PhaseView::Confirmed,
            LegacyPhase::Failed => PhaseView::Failed,
        };
        let outcome = if self.failure.is_some() {
            Outcome::FailureRecorded
        } else if self.phase == LegacyPhase::Confirmed {
            Outcome::SuccessRecorded
        } else {
            Outcome::NotRecorded
        };
        View::observed(phase, outcome, self.pending.is_some().then_some(true), None)
    }
}
