use crate::{
    engine_metadata::EngineError, office::OfficeError, worker_launch::CreateObservationError,
};
use reverie_contracts::worker_launch::NetworkDataError;
use std::sync::{Mutex, MutexGuard, TryLockError};
/// Keep the complete typed cause while sharing a laptop failure between its
/// real resource owners. Telemetry's general error can own a refused-close SQL
/// connection, which is Send but not Sync; a mutex preserves that ownership.
#[derive(Debug)]
pub struct CreateTelemetryFailure {
    code: &'static str,
    cause: Mutex<crate::command_telemetry::TelemetryError>,
}
pub struct TelemetryCause<'a>(MutexGuard<'a, crate::command_telemetry::TelemetryError>);
impl std::ops::Deref for TelemetryCause<'_> {
    type Target = crate::command_telemetry::TelemetryError;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl CreateTelemetryFailure {
    pub(super) fn new(cause: crate::command_telemetry::TelemetryError) -> Self {
        Self {
            code: cause.code(),
            cause: Mutex::new(cause),
        }
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    /// Readonly borrowed diagnostics; contention never discards the cause.
    pub fn cause(&self) -> Option<TelemetryCause<'_>> {
        match self.cause.try_lock() {
            Ok(cause) => Some(TelemetryCause(cause)),
            Err(TryLockError::Poisoned(error)) => Some(TelemetryCause(error.into_inner())),
            Err(TryLockError::WouldBlock) => None,
        }
    }
}
impl std::fmt::Display for CreateTelemetryFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
// Standard Error::source cannot return a borrow past a mutex guard. The
// readonly cause() owner above retains the complete original typed value.
impl std::error::Error for CreateTelemetryFailure {}

#[derive(Debug)]
pub enum LaptopError {
    Refused(&'static str),
    Plan(CreateObservationError),
    ExistingObservation(crate::worker_launch::ExistingObservationError),
    OrdinaryStop(crate::worker_source_stop::SourceStopError),
    StorageOwner(crate::worker_storage::StorageOwnerError),
    Office(OfficeError),
    Network(NetworkDataError),
    Engine(EngineError),
    Nix(crate::worker_nix::NixError),
    Telemetry(CreateTelemetryFailure),
    Identity(reverie_store::storage_identity::IdentityError),
    Data(reverie_contracts::worker_launch::LaunchDataError),
    CreatedState(reverie_contracts::worker_launch::CreatedStateError),
    Configuration(reverie_contracts::broker_resources::ResourceConfigError),
    Io(std::io::Error),
    Terminal(crate::terminal_pty::PtyError),
    Publication(crate::worker_child::ChildError),
    Observation(crate::ObservationError),
    MemoryKernel(crate::reservation_kernel::ReservationKernelError),
    MemoryData(reverie_contracts::reservation_engine::EngineDataError),
    MemoryIdentity(reverie_contracts::worker_recovery::RecoveryDataError),
    MemoryHelperSelection(reverie_contracts::worker_validation::WorkerValidationError),
    ColdPolicy(reverie_contracts::worker_validation::WorkerValidationError),
    ColdStorage(crate::worker_storage::StorageOwnerError),
    MemoryHelperRefused(String),
    MemoryEffectUnconfirmed(Box<Self>),
    Recorded(std::sync::Arc<Self>),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for LaptopError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl LaptopError {
    pub(super) fn unconfirmed_native(&self) -> bool {
        match self {
            Self::OrdinaryStop(_) => true,
            Self::MemoryEffectUnconfirmed(_) => true,
            Self::ColdStorage(error) => error.unconfirmed_native(),
            Self::StorageOwner(error) => error.unconfirmed_native(),
            Self::Observation(_) => true,
            Self::Publication(error) => !error.cleanup_faults().is_empty(),
            Self::Finalization { primary, secondary } => {
                primary.unconfirmed_native() || secondary.unconfirmed_native()
            }
            Self::Recorded(error) => error.unconfirmed_native(),
            _ => false,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Plan(_) => "WORKER_LAPTOP_PLAN",
            Self::ExistingObservation(_) => "WORKER_EXISTING_VIEWER_OBSERVATION",
            Self::OrdinaryStop(error) => error.code(),
            Self::Office(_) => "WORKER_LAPTOP_OFFICE",
            Self::Network(_) => "WORKER_LAPTOP_NETWORK",
            Self::Engine(error) => error.code(),
            Self::Nix(_) => "WORKER_LAPTOP_NIX",
            Self::Telemetry(error) => error.code(),
            Self::Identity(_) => "WORKER_LAPTOP_IDENTITY",
            Self::Data(_) => "WORKER_LAPTOP_DATA",
            Self::CreatedState(_) => "WORKER_LAPTOP_CREATED_STATE_UNCONFIRMED",
            Self::Configuration(_) => "WORKER_LAPTOP_CONFIGURATION",
            Self::Io(_) => "WORKER_LAPTOP_IO",
            Self::Terminal(_) => "WORKER_VIEWER_TERMINAL",
            Self::Publication(_) => "WORKER_LAPTOP_LAUNCH_PUBLICATION",
            Self::Observation(_) => "WORKER_LAPTOP_NATIVE_FINALIZATION",
            Self::MemoryKernel(error) => error.code(),
            Self::MemoryData(error) => error.code(),
            Self::MemoryIdentity(error) => error.code(),
            Self::MemoryHelperSelection(_) => "LAPTOP_SOFT_LIMIT_HELPER_SELECTION",
            Self::ColdPolicy(_) => "WORKER_COLD_POLICY",
            Self::ColdStorage(error) => error.code(),
            Self::StorageOwner(error) => error.code(),
            Self::MemoryHelperRefused(_) => "LAPTOP_SOFT_LIMIT_HELPER_REFUSED",
            Self::MemoryEffectUnconfirmed(_) => "LAPTOP_MEMORY_EFFECT_UNCONFIRMED",
            Self::Recorded(error) => error.code(),
            Self::Finalization { primary, .. } => primary.code(),
        }
    }
}
impl std::error::Error for LaptopError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(_) => None,
            Self::Plan(error) => Some(error),
            Self::ExistingObservation(error) => Some(error),
            Self::OrdinaryStop(error) => Some(error),
            Self::Office(error) => Some(error),
            Self::Network(error) => Some(error),
            Self::Engine(error) => Some(error),
            Self::Nix(error) => Some(error),
            Self::Telemetry(error) => Some(error),
            Self::Identity(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::CreatedState(error) => Some(error),
            Self::Configuration(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::Terminal(error) => Some(error),
            Self::Publication(error) => Some(error),
            Self::Observation(error) => Some(error),
            Self::MemoryKernel(error) => Some(error),
            Self::MemoryData(error) => Some(error),
            Self::MemoryIdentity(error) => Some(error),
            Self::MemoryHelperSelection(error) => Some(error),
            Self::ColdPolicy(error) => Some(error),
            Self::ColdStorage(error) => Some(error),
            Self::StorageOwner(error) => Some(error),
            Self::MemoryHelperRefused(_) => None,
            Self::MemoryEffectUnconfirmed(error) => Some(error.as_ref()),
            Self::Recorded(error) => Some(error.as_ref()),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
        }
    }
}
pub(super) type Result<T> = std::result::Result<T, LaptopError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(LaptopError::Refused(code))
    }
}
pub(super) fn finalized<T>(result: Result<T>, secondary: Result<()>) -> Result<T> {
    match (result, secondary) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(LaptopError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
