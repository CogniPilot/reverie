//! Recovery's existing soft-memory/native verification over genuine same-
//! service inspection. This grants no registration, CID custody or start.
use crate::{
    reservation_observer::{NativeObserver, ObserverError},
    resource_staging,
    worker_validation::ValidatedWorkerSnapshot,
};
use reverie_contracts::{
    reservation_engine::{EngineDataError, ObservedMemoryPolicy},
    worker_config,
    worker_recovery::RecoveryDataError,
};
use reverie_host::{
    worker_recovery::{RecoveryContainerInspection, WorkerRecoveryError},
    worker_runtime::WorkerRuntime,
};
use std::fmt;
#[derive(Debug)]
pub enum RecoveryMemoryError {
    Host(WorkerRecoveryError),
    Data(RecoveryDataError),
    Resources(resource_staging::ResourceServiceError),
    Policy(EngineDataError),
    Observer(ObserverError),
}
impl fmt::Display for RecoveryMemoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Host(error) => error.fmt(f),
            Self::Data(error) => error.fmt(f),
            Self::Resources(error) => error.fmt(f),
            Self::Policy(error) => error.fmt(f),
            Self::Observer(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for RecoveryMemoryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Host(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Resources(error) => Some(error),
            Self::Policy(error) => Some(error),
            Self::Observer(error) => Some(error),
        }
    }
}
macro_rules! convert {
    ($from:ty,$variant:ident) => {
        impl From<$from> for RecoveryMemoryError {
            fn from(error: $from) -> Self {
                Self::$variant(error)
            }
        }
    };
}
convert!(WorkerRecoveryError, Host);
convert!(RecoveryDataError, Data);
convert!(resource_staging::ResourceServiceError, Resources);
convert!(EngineDataError, Policy);
convert!(ObserverError, Observer);
pub fn verify_recovered_memory(
    runtime: &WorkerRuntime,
    snapshot: &ValidatedWorkerSnapshot,
    row: &RecoveryContainerInspection,
) -> Result<(), RecoveryMemoryError> {
    row.assert_binding(runtime, snapshot.envelope().base())?;
    let source = snapshot.configuration();
    let resources = resource_staging::effective_config(source.clone(), row.session())?;
    if ObservedMemoryPolicy::from_effective(&resources)?.is_none() {
        return Ok(());
    }
    row.data()
        .assert_memory_namespace(snapshot.envelope().base().deployment(), row.session())?;
    // Namespace refusal precedes this second real effective-config observation.
    let repeated = resource_staging::effective_config(source.clone(), row.session())?;
    row.data()
        .assert_memory_policy(&worker_config::policy_digest(&repeated))?;
    let context = NativeObserver::capture_worker(runtime, source.clone());
    context.host_root()?;
    context.verify_recovery_limits(row.data())?;
    Ok(())
}
