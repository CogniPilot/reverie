//! One logical observation's actual admitted calls on the SAME shared client.
//! An empty owner never scans, aborts or settles another context's active slot.
use super::*;
use crate::captured_client::{CapturedCall, CapturedOutput, CleanupFault, Policy};
use reverie_core::worker_laptop::WorkerContainerName;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
#[derive(Default)]
struct State {
    primary: Option<EngineError>,
    pending: Option<CapturedCall>,
}
#[must_use = "retain original pending query custody until exact checked settlement"]
pub struct MetadataQueryOwner {
    engine: ReadonlyEngine,
    state: Mutex<State>,
}
impl ReadonlyEngine {
    /// Fresh observation custody, sharing this actual client and its admission
    /// slot, not another supervisor, registry, command or effect permission.
    pub fn capture_query_owner(&self) -> MetadataQueryOwner {
        MetadataQueryOwner {
            engine: self.clone(),
            state: Mutex::new(State::default()),
        }
    }
}
impl MetadataQueryOwner {
    pub fn assert_engine(&self, engine: &ReadonlyEngine) -> Result<()> {
        if Arc::ptr_eq(&self.engine.client, &engine.client) {
            Ok(())
        } else {
            Err(EngineError::new(EngineFault::Identity))
        }
    }
    pub fn query(
        &self,
        query: EngineQuery<'_>,
        end: Instant,
        cancellation: &CancellationToken,
    ) -> Result<String> {
        let result = self.run(query.arguments()?, end, cancellation, true)?;
        Ok(String::from_utf8(result.stdout).expect("same metadata policy validates UTF8"))
    }
    /// The original fixed optional by-name inspection; a nonzero exit remains
    /// returned DATA. No arbitrary argv/program or success substitute exists.
    pub fn inspect_laptop(
        &self,
        name: &WorkerContainerName,
        end: Instant,
        cancellation: &CancellationToken,
    ) -> Result<crate::broker_engine::LaptopInspectOutput> {
        let result = self.run(
            crate::broker_engine::inspect_laptop_arguments(name),
            end,
            cancellation,
            false,
        )?;
        Ok(crate::broker_engine::LaptopInspectOutput {
            stdout: result.stdout,
            succeeded: result.succeeded,
        })
    }
    fn run(
        &self,
        arguments: Vec<OsString>,
        end: Instant,
        cancellation: &CancellationToken,
        successful_exit: bool,
    ) -> Result<CapturedOutput> {
        let mut state = self.state.try_lock().map_err(|_| unavailable())?;
        if let Some(primary) = &state.primary {
            return Err(primary.clone());
        }
        match self.engine.client.run_scoped(
            arguments,
            end,
            cancellation,
            Policy {
                maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                maximum_output: MAX_OUTPUT_BYTES,
                successful_exit,
            },
        ) {
            Ok(output) => Ok(output), // the exact successful call already finalized/released
            Err(failure) => {
                let error = EngineError::from(failure.error);
                state.primary = Some(error.clone());
                state.pending = failure.call;
                Err(error)
            }
        }
    }
    /// Settle only the original actual ticket, never the shared active slot.
    /// The body error remains latched, including after later known settlement.
    pub fn settle_owned(&self, end: Instant) -> Result<()> {
        let mut state = self.state.try_lock().map_err(|_| unavailable())?;
        if let Some(call) = &state.pending {
            self.engine
                .client
                .settle_call(call, end)
                .map_err(EngineError::from)?;
            state.pending = None;
        }
        Ok(())
    }
}
fn unavailable() -> EngineError {
    EngineError {
        fault: EngineFault::Supervisor,
        cleanup: vec![CleanupFault::Supervisor],
        uncertain: true,
    }
}
impl Drop for MetadataQueryOwner {
    fn drop(&mut self) {
        let poisoned = self.state.is_poisoned();
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        let pending = state.pending.take();
        if poisoned
            || pending.as_ref().is_some_and(|call| {
                state
                    .primary
                    .as_ref()
                    .is_some_and(EngineError::is_uncertain)
                    || call.has_pending_native_work()
            })
        {
            // Unchecked destruction cannot release an uncertain native owner,
            // including a consumed close with no handle, or a poisoned scope.
            std::mem::forget(pending);
            std::mem::forget(self.engine.clone());
        }
        // Known-completed failed output is only DATA. Dropping it performs
        // no native cleanup, query replay or physical resource release.
    }
}
