//! Shared actual stop/Office/storage finalizers, with no transport or authority factory.
use super::*;
use std::time::Instant;

pub(super) struct SeatStop {
    pub(super) stop: Option<storage::ControlStorageStop>,
    pub(super) claim: Option<StorageClaim>,
    pub(super) office: Option<Arc<recovered::RecoveredOffice>>,
}
impl SeatStop {
    pub(super) fn stop(&self) -> Result<(), StorageWorkflowError> {
        self.stop.as_ref().expect("actual stop owner").stop()
    }
    pub(super) fn settle(&self, end: Instant) -> Result<(), StorageWorkflowError> {
        self.stop.as_ref().map_or(Ok(()), |stop| stop.settle(end))
    }
    pub(super) fn finish(&mut self, end: Instant) -> Result<(), StorageWorkflowError> {
        if let Some(office) = &self.office {
            office.close_for_stopped_source(end)?;
        }
        let stop = self.stop.take().expect("actual stopped owner");
        match stop.reclaim(end) {
            Ok(claim) => self.claim = Some(claim),
            Err(failure) => {
                let (stop, cause) = *failure;
                self.stop = Some(stop);
                return Err(cause);
            }
        }
        let claim = self.claim.take().expect("same reclaimed Box");
        if let Err(failure) = claim.release(end) {
            let (claim, cause) = failure.into_parts();
            self.claim = Some(claim);
            return Err(cause);
        }
        Ok(())
    }
}
