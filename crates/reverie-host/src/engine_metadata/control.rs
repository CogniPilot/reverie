use super::{
    EngineBootstrap, EngineError, EngineQuery, MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS, Result,
};
pub use crate::captured_client::CancellationToken;
use crate::captured_client::{CapturedClient, Policy};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
/// Closed metadata-only wrapper over the shared exact-client supervisor. Keep
/// retained contexts and check settle_owned before acknowledging shutdown.
#[must_use = "retain the engine context and check settle_owned before shutdown acknowledgement"]
#[derive(Clone)]
pub struct ReadonlyEngine {
    pub(crate) client: Arc<CapturedClient>,
}
impl ReadonlyEngine {
    /// Pure exact captured-client provenance, never matching socket/path/ID
    /// DATA and never a process, source, currentness or effect authorization.
    pub fn assert_worker_runtime(
        &self,
        runtime: &crate::worker_runtime::WorkerRuntime,
    ) -> Result<()> {
        if Arc::ptr_eq(&self.client, &runtime.installed_engine().engine.client) {
            Ok(())
        } else {
            Err(EngineError::new(super::EngineFault::Identity))
        }
    }
    pub fn new(bootstrap: EngineBootstrap) -> Self {
        Self {
            client: Arc::new(CapturedClient::new(bootstrap.into_command())),
        }
    }
    pub fn query(
        &self,
        query: EngineQuery<'_>,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<String> {
        let args = query.arguments()?;
        let captured = self
            .client
            .run(
                args,
                deadline,
                cancellation,
                Policy {
                    maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                    maximum_output: MAX_OUTPUT_BYTES,
                    successful_exit: true,
                },
            )
            .map_err(EngineError::from)?;
        let _ = (captured.stderr, captured.succeeded);
        Ok(String::from_utf8(captured.stdout).expect("shared metadata policy validated UTF8"))
    }
    pub fn settle_owned(&self, deadline: Instant) -> Result<()> {
        self.client.settle_owned(deadline).map_err(Into::into)
    }
    /// Seal new admission before checking shutdown settlement. Ordinary
    /// settle_owned retains its source-compatible reusable-context behavior.
    pub fn close(&self, deadline: Instant) -> Result<()> {
        self.client.close(deadline).map_err(Into::into)
    }
}
