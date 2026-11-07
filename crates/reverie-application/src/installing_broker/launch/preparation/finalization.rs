//! Shared cleanup timing and actual handler owners, plus negative prefix
//! finalization. Metadata or transport cleanup never authorizes resource release.
use super::*;
/// Fixed finalization purposes share timing and actual handler owners. Neither
/// an empty local error list nor socket closure grants physical resource release.
#[derive(Clone, Copy)]
pub(super) enum CleanupBudget {
    Bounded(Instant),
    Worker,
}
impl CleanupBudget {
    pub(super) fn phase(self, milliseconds: u64) -> Instant {
        match self {
            Self::Bounded(end) => end,
            Self::Worker => Instant::now() + std::time::Duration::from_millis(milliseconds),
        }
    }
    pub(super) fn lifecycle(
        self,
        broker: &InstallingBroker,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        match self {
            Self::Bounded(end) => {
                let end = broker
                    .storage
                    .runtime
                    .stop_deadline()
                    .map_or(end, |stop| end.min(stop));
                broker.installed.cleanup_lifecycle_until(end)
            }
            Self::Worker => broker.installed.cleanup_lifecycle(&broker.storage.runtime),
        }
    }
    pub(super) fn metadata(
        self,
        preparing: &PreparingWorkerLaunch<'_>,
        active: Option<&ActiveLaunchToken<'_>>,
    ) -> Result<(), GateError> {
        let Some(token) = active else {
            return Ok(());
        };
        self.lifecycle(preparing.broker())?.finalize_active(token)
    }
    pub(super) fn close_request(
        self,
        request: &ReceivedWorkerLaunch<'_>,
    ) -> Result<(), WorkerReportError> {
        match self {
            Self::Bounded(end) => request.close(end),
            Self::Worker => request.close_for_worker(),
        }
    }
    /// The actual resource finalizer chooses this only after known ownership
    /// transfer/closure and checked socket close. It cannot forgive uncertainty.
    pub(super) fn release_hold(
        self,
        token: &mut ActiveLaunchToken<'_>,
    ) -> Result<(), WorkerReportError> {
        match self {
            Self::Bounded(end) => token.release_handler_hold(end),
            Self::Worker => token.release_handler_hold_for_worker(),
        }
    }
}
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
        let budget = CleanupBudget::Bounded(end);
        if let Err(error) = budget.metadata(&self.preparing, self.active.as_ref()) {
            self.cleanup.push(error.into());
        }
        if let Err(error) = budget.close_request(&self.preparing.admitted.request) {
            self.cleanup.push(error.into());
        }
        &self.cleanup
    }
}
