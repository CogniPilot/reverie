//! No producer, settlement, fd access or arbitrary error rendering is allowed.
use super::*;
use reverie_contracts::worker_storage_status::{
    OwnerObservation as View, OwnerPhase as PhaseView, RecordedOutcome as Outcome,
};
impl ExistingViewer {
    pub fn storage_owner_status(&self) -> View {
        let record = match self.reference.record.try_lock() {
            Ok(record) => record,
            Err(std::sync::TryLockError::WouldBlock) => return View::Busy,
            Err(std::sync::TryLockError::Poisoned(_)) => return View::Poisoned,
        };
        let phase = match record.stage {
            Stage::Held => PhaseView::Held,
            Stage::Starting => PhaseView::Starting,
            Stage::Viewing => PhaseView::Viewing,
            Stage::Retained => PhaseView::Retained,
            Stage::Closing => PhaseView::Closing,
            Stage::Closed => PhaseView::Closed,
            Stage::Consumed => PhaseView::Consumed,
        };
        let outcome = if record.failure.is_some() {
            Outcome::FailureRecorded
        } else {
            Outcome::NotRecorded
        };
        let pending = record.finalization.diagnostic_pending();
        // No aggregate classifier exists for the viewer process, stop attempt
        // and final storage query. Do not infer known-clear from a missing ticket.
        View::observed(phase, outcome, pending.then_some(true), None)
            .with_final_check(record.finalization.diagnostic_phase())
    }
}
