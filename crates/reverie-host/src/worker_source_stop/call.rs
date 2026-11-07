use super::*;
use crate::{
    captured_client::{CancellationToken, CapturedOutput, Policy},
    engine_metadata::{MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS},
};
use std::{ffi::OsString, time::Duration};
impl OriginalSourceStop {
    pub(super) fn read_end(&self) -> Instant {
        let end = Instant::now() + Duration::from_secs(MAX_QUERY_SECONDS);
        [self.deadline, self.origin.stop_deadline()]
            .into_iter()
            .flatten()
            .fold(end, Instant::min)
    }
    pub(super) fn call(&mut self, args: Vec<OsString>, required: bool) -> Result<CapturedOutput> {
        let end = self.read_end();
        need(Instant::now() < end, "RESOURCE_SOURCE_STOP_DEADLINE")?;
        match self.origin.engine.client.run_scoped(
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
                    self.pending = failure.call;
                }
                Err(SourceStopError::Engine(failure.error.into()))
            }
        }
    }
}
