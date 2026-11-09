use super::*;
use crate::{
    captured_client::{CancellationToken, CapturedOutput, Policy},
    engine_metadata::{MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS},
};
use std::{ffi::OsString, time::Duration};
#[cfg(test)]
pub(super) mod probe;
impl ExactStopAttempt {
    pub(super) fn read_end(&self) -> Instant {
        let end = Instant::now() + Duration::from_secs(MAX_QUERY_SECONDS);
        [self.deadline, self.origin.stop_deadline()]
            .into_iter()
            .flatten()
            .fold(end, Instant::min)
    }
    pub(super) fn call(&mut self, args: Vec<OsString>, required: bool) -> Result<CapturedOutput> {
        captured(
            &self.origin,
            self.read_end(),
            &mut self.pending,
            args,
            required,
        )
    }
}
/// One private fixed-client call owner for the distinct stop purposes. No raw
/// command interface leaves this module; each purpose selects its own argv.
pub(super) fn captured(
    origin: &InstalledWorkerEngine,
    end: Instant,
    pending: &mut Option<CapturedCall>,
    args: Vec<OsString>,
    required: bool,
) -> Result<CapturedOutput> {
    capture(origin, end, pending, args, required, Admission::Immediate)
}
pub(crate) fn captured_for_worker(
    origin: &InstalledWorkerEngine,
    end: Instant,
    pending: &mut Option<CapturedCall>,
    args: Vec<OsString>,
    required: bool,
) -> Result<CapturedOutput> {
    capture(
        origin,
        end,
        pending,
        args,
        required,
        Admission::WaitBeforeStart,
    )
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Admission {
    Immediate,
    WaitBeforeStart,
}
fn capture(
    origin: &InstalledWorkerEngine,
    original: Instant,
    pending: &mut Option<CapturedCall>,
    args: Vec<OsString>,
    required: bool,
    admission: Admission,
) -> Result<CapturedOutput> {
    loop {
        // The per-query end was captured ONCE. Busy admitted no job, but cannot
        // renew that original window or the live first-stop deadline.
        let end = origin
            .stop_deadline()
            .map_or(original, |stop| original.min(stop));
        need(Instant::now() < end, "RESOURCE_SOURCE_STOP_DEADLINE")?;
        match origin.engine.client.run_scoped(
            args.clone(),
            end,
            &CancellationToken::new(),
            Policy {
                maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                maximum_output: MAX_OUTPUT_BYTES,
                successful_exit: required,
            },
        ) {
            Ok(output) => return Ok(output),
            Err(failure) => {
                let before_busy = failure.call.is_none()
                    && !failure.error.may_have_started
                    && failure.error.fault == crate::captured_client::Fault::Busy;
                #[cfg(test)]
                if before_busy {
                    probe::observed();
                }
                if before_busy && admission == Admission::WaitBeforeStart {
                    std::thread::sleep(
                        end.saturating_duration_since(Instant::now())
                            .min(Duration::from_millis(5)),
                    );
                    continue;
                }
                eprintln!(
                    "WORKER_SOURCE_QUERY_FAILED fault={:?} cleanup={:?} admitted={} may_have_started={} uncertain={}",
                    failure.error.fault,
                    failure.error.cleanup,
                    failure.call.is_some(),
                    failure.error.may_have_started,
                    failure.error.uncertain,
                );
                if failure.error.is_uncertain() {
                    *pending = failure.call;
                }
                return Err(SourceStopError::Engine(failure.error.into()));
            }
        }
    }
}
