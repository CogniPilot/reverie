//! Pure local projection of the original record, never an observation producer.
use super::*;
use reverie_contracts::worker_storage_status::{
    OwnerObservation as View, OwnerPhase as PhaseView, RecordedOutcome as Outcome,
};
impl LaptopWorkflow {
    pub fn storage_owner_status(&self) -> View {
        let record = match self.record.try_lock() {
            Ok(record) => record,
            Err(std::sync::TryLockError::WouldBlock) => return View::Busy,
            Err(std::sync::TryLockError::Poisoned(_)) => return View::Poisoned,
        };
        let phase = match record.phase {
            Phase::Held => PhaseView::Held,
            Phase::Running => PhaseView::Running,
            Phase::Known => PhaseView::Known,
            Phase::MemberRefused | Phase::Retained => PhaseView::Retained,
            Phase::Cleaning => PhaseView::Cleaning,
            Phase::FinalizingStarted => PhaseView::FinalizingStarted,
            Phase::Stopped => PhaseView::Stopped,
            Phase::CleanupRetained => PhaseView::CleanupRetained,
            Phase::Consumed => PhaseView::Consumed,
        };
        let outcome = match &record.outcome {
            None => Outcome::NotRecorded,
            Some(Ok(())) => Outcome::SuccessRecorded,
            Some(Err(_)) => Outcome::FailureRecorded,
        };
        // Viewer, creation and storage subowners may retain native work beyond
        // these local fields. Preserve positive facts; absence is not a
        // complete transitive native classification.
        View::observed(
            phase,
            outcome,
            record.pending.is_some().then_some(true),
            record.unknown.then_some(true),
        )
        .with_final_check(record.finalization.diagnostic_phase())
    }
}
