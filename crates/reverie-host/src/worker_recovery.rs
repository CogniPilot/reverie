//! Source recovery queries on the actual existing service capture. These are
//! membership/inspection observations, not exact CID/process effect authority.
use crate::{
    captured_client::Policy,
    engine_metadata::{EngineError, MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS},
    installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use reverie_contracts::worker_recovery::{
    RecoveryDataError, RecoveryInspection, RecoveryInspectionNeed, RecoveryNames,
};
use reverie_core::{
    worker_laptop::WorkerContainerName,
    worker_schema::{WorkerBase, WorkerServiceIdentity},
};
use std::{
    ffi::OsString,
    fmt,
    sync::Arc,
    time::{Duration, Instant},
};
#[derive(Debug)]
pub enum WorkerRecoveryError {
    Engine(EngineError),
    Data(RecoveryDataError),
    Census(crate::creation_budget::CreationHostError),
    Namespace,
    Encoding,
}
impl WorkerRecoveryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Engine(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Census(error) => error.code(),
            Self::Namespace => "WORKER_RECOVERY_SERVICE_NAMESPACE",
            Self::Encoding => "WORKER_RECOVERY_ENCODING",
        }
    }
}
impl fmt::Display for WorkerRecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for WorkerRecoveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Engine(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Census(error) => Some(error),
            Self::Namespace | Self::Encoding => None,
        }
    }
}
impl From<RecoveryDataError> for WorkerRecoveryError {
    fn from(error: RecoveryDataError) -> Self {
        Self::Data(error)
    }
}
impl From<EngineError> for WorkerRecoveryError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}
type Result<T> = std::result::Result<T, WorkerRecoveryError>;
pub(crate) struct ContainerReadFailure {
    pub(crate) error: WorkerRecoveryError,
    pub(crate) call: Option<crate::captured_client::CapturedCall>,
}
impl From<WorkerRecoveryError> for ContainerReadFailure {
    fn from(error: WorkerRecoveryError) -> Self {
        Self { error, call: None }
    }
}
impl From<RecoveryDataError> for ContainerReadFailure {
    fn from(error: RecoveryDataError) -> Self {
        WorkerRecoveryError::Data(error).into()
    }
}
pub struct RecoveryCensus {
    origin: Arc<InstalledWorkerEngine>,
    names: RecoveryNames,
}
impl RecoveryCensus {
    pub fn names(&self) -> &RecoveryNames {
        &self.names
    }
}
pub struct RecoveryContainerInspection {
    origin: Arc<InstalledWorkerEngine>,
    session: reverie_core::ids::ProfileSessionId,
    data: RecoveryInspection,
}
impl RecoveryContainerInspection {
    pub fn session(&self) -> &reverie_core::ids::ProfileSessionId {
        &self.session
    }
    pub fn data(&self) -> &RecoveryInspection {
        &self.data
    }
    pub fn assert_runtime(&self, runtime: &WorkerRuntime) -> Result<()> {
        if Arc::ptr_eq(&self.origin, runtime.installed_engine()) {
            Ok(())
        } else {
            Err(WorkerRecoveryError::Namespace)
        }
    }
    pub fn assert_binding(&self, runtime: &WorkerRuntime, base: &WorkerBase) -> Result<()> {
        self.assert_runtime(runtime)?;
        if WorkerServiceIdentity::capture(base) == *runtime.worker_identity() {
            Ok(())
        } else {
            Err(WorkerRecoveryError::Namespace)
        }
    }
}
impl WorkerRuntime {
    pub fn observe_recovery_names(&self, base: &WorkerBase) -> Result<RecoveryCensus> {
        if WorkerServiceIdentity::capture(base) != *self.worker_identity() {
            return Err(WorkerRecoveryError::Namespace);
        }
        // This exact running-only query is already the creation peer owner;
        // neither a second runner nor the reservation all-CID query is used.
        let raw = self
            .creation_peer_names(query_end(self.installed_engine()))
            .map_err(WorkerRecoveryError::Census)?;
        Ok(RecoveryCensus {
            origin: self.installed_engine().clone(),
            names: RecoveryNames::decode(base, &raw)?,
        })
    }
    pub fn inspect_recovery_laptop(
        &self,
        census: &RecoveryCensus,
        name: &WorkerContainerName,
    ) -> Result<RecoveryContainerInspection> {
        if !Arc::ptr_eq(&census.origin, self.installed_engine()) {
            return Err(WorkerRecoveryError::Namespace);
        }
        let session = census
            .names
            .entries()
            .iter()
            .find(|(_, selected)| selected == name)
            .ok_or(WorkerRecoveryError::Namespace)?
            .0
            .clone();
        let data = inspect_fixed_container(self.installed_engine(), name.as_str())?;
        Ok(RecoveryContainerInspection {
            origin: self.installed_engine().clone(),
            session,
            data,
        })
    }
}
pub(crate) fn query_end(engine: &InstalledWorkerEngine) -> Instant {
    let end = Instant::now() + Duration::from_secs(MAX_QUERY_SECONDS);
    engine.stop_deadline().map_or(end, |stop| stop.min(end))
}
pub(crate) fn inspect_fixed_container(
    engine: &Arc<InstalledWorkerEngine>,
    name: &str,
) -> Result<RecoveryInspection> {
    inspect_fixed_container_scoped(engine, name).map_err(|failure| failure.error)
}
pub(crate) fn inspect_fixed_container_scoped(
    engine: &Arc<InstalledWorkerEngine>,
    name: &str,
) -> std::result::Result<RecoveryInspection, ContainerReadFailure> {
    let raw = query(engine, vec!["inspect".into(), name.into()], false)?;
    let stdout = std::str::from_utf8(&raw.stdout).map_err(|_| WorkerRecoveryError::Encoding)?;
    let stderr = std::str::from_utf8(&raw.stderr).map_err(|_| WorkerRecoveryError::Encoding)?;
    match RecoveryInspection::inspect_data(name, stdout, stderr, raw.shell_code)? {
        RecoveryInspectionNeed::Present(data) => Ok(data),
        RecoveryInspectionNeed::ConfirmAbsence => {
            let names = query(
                engine,
                ["ps", "--all", "--format", "{{.Names}}"]
                    .map(OsString::from)
                    .to_vec(),
                true,
            )?;
            let names =
                std::str::from_utf8(&names.stdout).map_err(|_| WorkerRecoveryError::Encoding)?;
            Ok(RecoveryInspection::confirmed_absence_data(name, names)?)
        }
    }
}
fn query(
    engine: &InstalledWorkerEngine,
    args: Vec<OsString>,
    successful_exit: bool,
) -> std::result::Result<crate::captured_client::CapturedOutput, ContainerReadFailure> {
    engine
        .engine
        .client
        .run_scoped(
            args,
            query_end(engine),
            &engine.cancellation(),
            Policy {
                maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                maximum_output: MAX_OUTPUT_BYTES,
                successful_exit,
            },
        )
        .map_err(|failure| ContainerReadFailure {
            error: WorkerRecoveryError::Engine(EngineError::from(failure.error)),
            call: failure.call,
        })
}
