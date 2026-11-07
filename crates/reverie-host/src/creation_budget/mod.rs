//! Named fixed read-side observations for the canonical creation budget. This
//! is not the reservation kernel observer or permission to mutate the engine.
mod kernel;
#[cfg(test)]
mod tests;
use crate::{
    captured_client::Policy,
    engine_metadata::{EngineError, MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS},
    worker_runtime::WorkerRuntime,
};
pub use kernel::CreationKernel;
use reverie_contracts::creation_budget::{CreationBudgetError, CreationPeerName};
use std::{
    ffi::OsString,
    fmt,
    time::{Duration, Instant},
};
#[derive(Debug)]
pub enum CreationHostError {
    Engine(EngineError),
    Data(CreationBudgetError),
    KernelData(reverie_contracts::kernel_accounting::KernelDataError),
    Observation(crate::ObservationError),
    Encoding,
    Deadline,
    Namespace,
    PoolActivation { cause: Box<Self> },
}
impl CreationHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Engine(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Observation(error) => error.code(),
            Self::KernelData(error) => error.code(),
            Self::Encoding => "WORKER_CREATION_KERNEL_ENCODING",
            Self::Deadline => "WORKER_CREATION_OBSERVATION_DEADLINE",
            Self::Namespace => "WORKER_CREATION_SERVICE_NAMESPACE",
            Self::PoolActivation { .. } => CreationBudgetError::PoolActivation.code(),
        }
    }
}
impl fmt::Display for CreationHostError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for CreationHostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Engine(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Observation(error) => Some(error),
            Self::KernelData(error) => Some(error),
            Self::PoolActivation { cause } => Some(cause.as_ref()),
            _ => None,
        }
    }
}
impl From<EngineError> for CreationHostError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}
impl From<CreationBudgetError> for CreationHostError {
    fn from(error: CreationBudgetError) -> Self {
        Self::Data(error)
    }
}
impl From<crate::ObservationError> for CreationHostError {
    fn from(error: crate::ObservationError) -> Self {
        Self::Observation(error)
    }
}
type Result<T> = std::result::Result<T, CreationHostError>;
impl WorkerRuntime {
    /// The actual running-only deployment census, distinct from storage CID or
    /// complete reservation inventory. It shares the captured pending fence.
    pub fn creation_peer_names(&self, end: Instant) -> Result<String> {
        let filter = format!(
            "label=reverie.worker={}",
            self.worker_identity().deployment()
        );
        let output = self
            .installed_engine()
            .engine
            .client
            .run(
                ["ps", "--filter", &filter, "--format", "{{.Names}}"]
                    .map(OsString::from)
                    .to_vec(),
                self.creation_deadline(end),
                &self.cancellation(),
                creation_policy(true),
            )
            .map_err(EngineError::from)?;
        String::from_utf8(output.stdout).map_err(|_| CreationHostError::Encoding)
    }
    /// Optional inspect is selected only by a checked name from the preceding
    /// same-service census/registry union; output is unqualified DATA.
    pub fn inspect_creation_peer(
        &self,
        name: &CreationPeerName<'_>,
        end: Instant,
    ) -> Result<crate::broker_engine::LaptopInspectOutput> {
        if name.deployment() != self.worker_identity().deployment() {
            return Err(CreationHostError::Namespace);
        }
        name.session()?;
        let output = self
            .installed_engine()
            .engine
            .client
            .run(
                ["inspect", name.name()].map(OsString::from).to_vec(),
                self.creation_deadline(end),
                &self.cancellation(),
                creation_policy(false),
            )
            .map_err(EngineError::from)?;
        Ok(crate::broker_engine::LaptopInspectOutput {
            stdout: output.stdout,
            succeeded: output.succeeded,
        })
    }
    fn creation_deadline(&self, end: Instant) -> Instant {
        self.stop_deadline().map_or(end, |stop| end.min(stop))
    }
}
fn creation_policy(successful_exit: bool) -> Policy {
    Policy {
        maximum: Duration::from_secs(MAX_QUERY_SECONDS),
        maximum_output: MAX_OUTPUT_BYTES,
        successful_exit,
    }
}
