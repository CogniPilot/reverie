//! Pure original-stop state. A failed phase is not a known stopped process.
use super::*;
use reverie_contracts::worker_storage_status::{
    OwnerObservation as View, OwnerPhase as PhaseView, RecordedOutcome as Outcome,
};
impl ExactStopAttempt {
    pub(super) fn diagnostic(&self) -> View {
        let phase = match self.phase {
            Phase::Held => PhaseView::Held,
            Phase::Inspecting => PhaseView::Inspecting,
            Phase::Policy => PhaseView::Policy,
            Phase::Stopping => PhaseView::Stopping,
            Phase::Stopped => PhaseView::Stopped,
            Phase::Closing => PhaseView::Closing,
            Phase::Failed => PhaseView::Failed,
            Phase::Closed => PhaseView::Closed,
        };
        let outcome = if self.failure.is_some() {
            Outcome::FailureRecorded
        } else {
            Outcome::NotRecorded
        };
        View::observed(phase, outcome, self.pending.is_some().then_some(true), None)
    }
}
impl OriginalSourceStop {
    pub fn storage_owner_status(&self) -> View {
        self.inner.diagnostic()
    }
}
