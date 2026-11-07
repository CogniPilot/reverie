//! The original single first-inspect result, sealed to its actual Runtime and
//! plan observation. Contract fields remain DATA; this alone grants no stop.
use super::*;
use crate::{
    captured_client::Policy,
    engine_metadata::{EngineError, MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS},
};
use reverie_contracts::broker_laptop::{LaptopReadError, LaunchLaptopInspection};
use std::{
    ffi::OsString,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub enum ExistingObservationError {
    Engine(EngineError),
    Data(LaptopReadError),
    Kernel(crate::reservation_kernel::ReservationKernelError),
    Owner(crate::worker_storage::StorageOwnerError),
    Origin,
}
impl std::fmt::Display for ExistingObservationError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Engine(error) => error.fmt(out),
            Self::Data(error) => error.fmt(out),
            Self::Kernel(error) => error.fmt(out),
            Self::Owner(error) => error.fmt(out),
            Self::Origin => out.write_str("WORKER_EXISTING_OBSERVATION_ORIGIN"),
        }
    }
}
impl std::error::Error for ExistingObservationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Engine(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Kernel(error) => Some(error),
            Self::Owner(error) => Some(error),
            Self::Origin => None,
        }
    }
}
pub struct ExistingLaptopInspection {
    origin: Arc<InstalledWorkerEngine>,
    storage_owner: Arc<()>,
    observation: Arc<()>,
    data: LaunchLaptopInspection,
}
mod pane;
mod process;
pub use pane::ExistingPaneState;
pub use process::{ExistingCaptureFailure, ExistingProcessIncarnation};
impl ExistingLaptopInspection {
    pub fn data(&self) -> &LaunchLaptopInspection {
        &self.data
    }
    /// Read-side binding only. Neither matching path data nor another plan on
    /// the same still-held storage can recreate this exact first observation.
    pub fn assert_plan(
        &self,
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
    ) -> std::result::Result<(), ExistingObservationError> {
        if Arc::ptr_eq(&self.origin, runtime.installed_engine())
            && Arc::ptr_eq(&self.origin, &plan.origin)
            && Arc::ptr_eq(&self.storage_owner, &plan.storage_owner)
            && Arc::ptr_eq(&self.observation, &plan.observation)
        {
            Ok(())
        } else {
            Err(ExistingObservationError::Origin)
        }
    }
}
impl ObservedCreatePlan {
    /// Fixed optional inspect on the SAME client. Its sealed result retains
    /// original observation identity for later process-incarnation capture;
    /// callers cannot assemble it from a CID, PID, status or contract reply.
    pub fn inspect_existing(
        &self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> std::result::Result<Option<ExistingLaptopInspection>, ExistingObservationError> {
        if !self.same_runtime(runtime) {
            return Err(ExistingObservationError::Origin);
        }
        let output = runtime
            .installed_engine()
            .engine
            .client
            .run(
                vec![
                    OsString::from("inspect"),
                    OsString::from(self.arguments.name()),
                ],
                end,
                &runtime.cancellation(),
                Policy {
                    maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                    maximum_output: MAX_OUTPUT_BYTES,
                    successful_exit: false,
                },
            )
            .map_err(|error| ExistingObservationError::Engine(error.into()))?;
        if !output.succeeded {
            return Ok(None);
        }
        let data = LaunchLaptopInspection::decode_owned(
            &output.stdout,
            runtime.worker_identity().deployment(),
            &self.session,
        )
        .map_err(ExistingObservationError::Data)?;
        let observation = ExistingLaptopInspection {
            origin: self.origin.clone(),
            storage_owner: self.storage_owner.clone(),
            observation: self.observation.clone(),
            data,
        };
        observation.assert_plan(runtime, self)?;
        Ok(Some(observation))
    }
}
