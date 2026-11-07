//! Negative prefix finalization only. Removing own handler metadata and closing
//! its transport never release the actual resource or the logical counted hold.
use super::*;
use std::sync::TryLockError;
impl<'a> InspectedWorkerLaunch<'a> {
    /// Stop this prefix's handler, retaining the SAME actual uncertain resources
    /// and logical hold in the returned failure. No positive release is minted.
    pub fn abort(self, end: Instant) -> Box<PreparationFailure<'a>> {
        let mut failure = self.observed.claimed.into_failure(
            PreparationError::Refused("WORKER_LAUNCH_PREPARATION_ABORTED"),
            Some(self.observed.current),
        );
        failure.close_transport(end);
        failure
    }
}
impl PreparationFailure<'_> {
    /// All-attempt, one-shot admission/metadata/socket finalization. An empty
    /// error slice means only these local actions completed; the failure still
    /// retains its actual resource context and SAME logical hold. In particular
    /// storage=None cannot prove acquisition was effect-free or globally closed.
    pub fn close_transport(&mut self, end: Instant) -> &[WorkerDispatchError] {
        if self.transport_attempted {
            return &self.cleanup;
        }
        self.transport_attempted = true;
        if let Some(admission) = self.preparing.admitted.admission.take()
            && let Err(error) = admission.close()
        {
            self.cleanup.push(error.into());
        }
        if let Some(token) = &self.active {
            let owner = &self.preparing.broker().installed;
            let end = self
                .preparing
                .broker()
                .storage
                .runtime
                .stop_deadline()
                .map_or(end, |stop| stop.min(end));
            let result = lifecycle(owner, end).and_then(|mut life| life.finalize_active(token));
            if let Err(error) = result {
                self.cleanup.push(error.into());
            }
        }
        if let Err(error) = self.preparing.admitted.request.close(end) {
            self.cleanup.push(error.into());
        }
        &self.cleanup
    }
}
fn lifecycle(owner: &InstalledWorker, end: Instant) -> Result<LaptopLifecycle<'_>, GateError> {
    loop {
        match owner.laptops.try_lock() {
            Ok(guard) => return Ok(LaptopLifecycle { owner, guard }),
            Err(TryLockError::Poisoned(_)) => {
                return Err(GateError::Refused("WORKER_BROKER_LOCK_UNAVAILABLE"));
            }
            Err(TryLockError::WouldBlock) => {}
        }
        let now = Instant::now();
        if now >= end {
            return Err(GateError::Refused("WORKER_BROKER_LOCK_UNAVAILABLE"));
        }
        std::thread::sleep(
            end.duration_since(now)
                .min(std::time::Duration::from_millis(1)),
        );
    }
}
