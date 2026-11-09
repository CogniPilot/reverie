//! Snapshot the same native workflow without advancing any original phase.
use super::*;
use reverie_contracts::worker_storage_status::{
    OwnerObservation as View, OwnerPhase as PhaseView, RecordedOutcome as Outcome,
};
impl NixWorkflow {
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
            Phase::Retained => PhaseView::Retained,
            Phase::Consumed => PhaseView::Consumed,
        };
        let outcome = match &record.outcome {
            None => Outcome::NotRecorded,
            Some(Ok(_)) => Outcome::SuccessRecorded,
            Some(Err(_)) => Outcome::FailureRecorded,
        };
        // Guard/storage/removal subowners are not classified by a missing
        // local ticket or a false local unknown-effect flag.
        View::observed(
            phase,
            outcome,
            record.pending_call.is_some().then_some(true),
            record.unknown_effect.then_some(true),
        )
    }
}
