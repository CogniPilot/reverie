//! The ordinary first inspect, after actual create-argument observation and
//! before runtime/exit/pane/memory reads. Keep the SAME lifecycle and resources.
use super::{observe::ObservedWorkerLaunch, *};
use reverie_contracts::broker_laptop::LaunchLaptopInspection;
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
    ) -> Result<Option<LaunchLaptopInspection>, PreparationError> {
        let runtime = &self.claimed.preparing.broker().storage.runtime;
        if !self.plan.same_runtime(runtime) {
            return Err(PreparationError::Refused("WORKER_LAUNCH_PLAN_ORIGIN"));
        }
        let name =
            WorkerContainerName::for_session(self.current.envelope().base(), self.plan.session());
        if name.as_str() != self.plan.arguments().name() {
            return Err(PreparationError::Refused("WORKER_LAUNCH_PLAN_NAME_CHANGED"));
        }
        // Existing closed-purpose adapter shares this actual Runtime's client,
        // pending-job fence and fixed 4 MiB/20s optional-inspect policy.
        let output = reverie_host::broker_engine::inspect_laptop(
            &runtime.readonly(),
            &name,
            end,
            &runtime.cancellation(),
        )?;
        if !output.succeeded {
            // Source treats optional nonzero as absent without parsing stdout.
            return Ok(None);
        }
        Ok(Some(LaunchLaptopInspection::decode_owned(
            &output.stdout,
            self.current.envelope().base().deployment(),
            self.plan.session(),
        )?))
    }
}

#[cfg(test)]
mod tests;
