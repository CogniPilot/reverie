//! Fixed broker laptop inspection on the SAME service-owned capture context.
//! The name is derived from checked installing data. Output is DATA, never
//! positive container ownership or a grant to create/start/attach a laptop.
use crate::{
    captured_client::Policy,
    engine_metadata::{
        CancellationToken, EngineError, MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS, ReadonlyEngine,
    },
};
use reverie_core::worker_laptop::WorkerContainerName;
use std::{
    ffi::OsString,
    time::{Duration, Instant},
};
pub struct LaptopInspectOutput {
    pub stdout: Vec<u8>,
    pub succeeded: bool,
}
impl std::fmt::Debug for LaptopInspectOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaptopInspectOutput")
            .field("stdout_bytes", &self.stdout.len())
            .field("succeeded", &self.succeeded)
            .finish()
    }
}
/// Preserve Broker.run_engine(optional=True): nonzero is returned for the
/// application to refuse before JSON parsing, with no engine diagnostic leak.
pub fn inspect_laptop(
    engine: &ReadonlyEngine,
    name: &WorkerContainerName,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<LaptopInspectOutput, EngineError> {
    let result = engine
        .client
        .run(
            inspect_laptop_arguments(name),
            deadline,
            cancellation,
            Policy {
                maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                maximum_output: MAX_OUTPUT_BYTES,
                successful_exit: false,
            },
        )
        .map_err(EngineError::from)?;
    let _ = result.stderr;
    Ok(LaptopInspectOutput {
        stdout: result.stdout,
        succeeded: result.succeeded,
    })
}
pub(crate) fn inspect_laptop_arguments(name: &WorkerContainerName) -> Vec<OsString> {
    vec![OsString::from("inspect"), OsString::from(name.as_str())]
}
