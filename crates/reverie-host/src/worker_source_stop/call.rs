use super::*;
use crate::{
    captured_client::{CancellationToken, CapturedOutput, Policy},
    engine_metadata::{MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS},
};
use std::{ffi::OsString, time::Duration};
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
    need(Instant::now() < end, "RESOURCE_SOURCE_STOP_DEADLINE")?;
    match origin.engine.client.run_scoped(
        args,
        end,
        &CancellationToken::new(),
        Policy {
            maximum: Duration::from_secs(MAX_QUERY_SECONDS),
            maximum_output: MAX_OUTPUT_BYTES,
            successful_exit: required,
        },
    ) {
        Ok(output) => Ok(output),
        Err(failure) => {
            if failure.error.is_uncertain() {
                *pending = failure.call;
            }
            Err(SourceStopError::Engine(failure.error.into()))
        }
    }
}
