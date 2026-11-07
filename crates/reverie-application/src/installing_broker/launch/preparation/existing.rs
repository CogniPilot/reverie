//! The ordinary first inspect, after actual create-argument observation and
//! before runtime/exit/pane/memory reads. Keep the SAME lifecycle and resources.
use super::{observe::ObservedWorkerLaunch, *};
use reverie_host::worker_launch::ExistingObservationError;
mod classify;
mod memory;
mod receipt;
pub use classify::{
    AllocationClosedReuse, ClassifiedWorkerLaunch, ColdWorkerLaunch, ExistingColdTarget,
    PreparedReuseViewer, RestoredReuse, ReusableWorkerLaunch, ReuseViewerFailure, ViewingReuse,
};
impl<'a> ObservedWorkerLaunch<'a> {
    pub(super) fn inspect(
        self,
        end: Instant,
    ) -> Result<InspectedWorkerLaunch<'a>, Box<PreparationFailure<'a>>> {
        match self.inspect_current(end) {
            Ok(previous) => Ok(InspectedWorkerLaunch {
                observed: self,
                previous,
            }),
            Err(cause) => Err(self.claimed.into_failure(cause, Some(self.current))),
        }
    }
    fn inspect_current(
        &self,
        end: Instant,
    ) -> Result<Option<ExistingLaptopInspection>, PreparationError> {
        let runtime = &self.claimed.preparing.broker().storage.runtime;
        if !self.plan.same_runtime(runtime) {
            return Err(PreparationError::Refused("WORKER_LAUNCH_PLAN_ORIGIN"));
        }
        let name =
            WorkerContainerName::for_session(self.current.envelope().base(), self.plan.session());
        if name.as_str() != self.plan.arguments().name() {
            return Err(PreparationError::Refused("WORKER_LAUNCH_PLAN_NAME_CHANGED"));
        }
        self.plan
            .inspect_existing(runtime, end)
            .map_err(|error| match error {
                ExistingObservationError::Engine(error) => PreparationError::Engine(error),
                ExistingObservationError::Data(error) => PreparationError::Existing(error),
                ExistingObservationError::Origin => {
                    PreparationError::Refused("WORKER_LAUNCH_PLAN_ORIGIN")
                }
                error => PreparationError::ExistingHost(error),
            })
    }
}

#[cfg(test)]
mod tests;
