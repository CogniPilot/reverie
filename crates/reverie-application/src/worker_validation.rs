//! Complete ordered worker configuration validation, not startup, permission or
//! durable native custody. Effects must establish fresh admitted observations.
use reverie_contracts::{
    rootless::RootlessConfig,
    worker_config::EffectiveWorkerConfig,
    worker_schema::WorkerEnvelope,
    worker_validation::{PrivateSelector, WorkerValidationData},
};
use reverie_host::{rootless, worker_mounts, worker_validation as host};
type Result<T> = std::result::Result<T, WorkerValidationError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerValidationStage {
    Loader,
    Header,
    HelperMemory,
    Reservation,
    Ops,
    Browser,
    ResourceActor,
    TelemetryMaps,
    Rootless,
    Goal,
    BaseMounts,
    Lease,
    Cold,
}
#[derive(Debug)]
pub struct WorkerValidationError {
    stage: WorkerValidationStage,
    cause: WorkerValidationCause,
}
#[derive(Debug)]
pub enum WorkerValidationCause {
    Data(reverie_contracts::worker_validation::WorkerValidationError),
    Native(host::WorkerValidationHostError),
    Rootless(rootless::RootlessHostError),
    Mount(worker_mounts::WorkerMountError),
    Lease(reverie_contracts::lease_policy::LeaseDataError),
}
impl WorkerValidationCause {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Data(_) => "WORKER_VALIDATION_DATA",
            Self::Native(e) => e.code(),
            Self::Rootless(e) => e.code(),
            Self::Mount(e) => e.code(),
            Self::Lease(e) => e.code(),
        }
    }
}
impl std::fmt::Display for WorkerValidationCause {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for WorkerValidationCause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Data(error) => Some(error),
            Self::Native(error) => Some(error),
            Self::Rootless(error) => Some(error),
            Self::Mount(error) => Some(error),
            Self::Lease(error) => Some(error),
        }
    }
}
impl From<reverie_contracts::worker_validation::WorkerValidationError> for WorkerValidationCause {
    fn from(value: reverie_contracts::worker_validation::WorkerValidationError) -> Self {
        Self::Data(value)
    }
}
impl From<host::WorkerValidationHostError> for WorkerValidationCause {
    fn from(value: host::WorkerValidationHostError) -> Self {
        Self::Native(value)
    }
}
impl From<rootless::RootlessHostError> for WorkerValidationCause {
    fn from(value: rootless::RootlessHostError) -> Self {
        Self::Rootless(value)
    }
}
impl From<worker_mounts::WorkerMountError> for WorkerValidationCause {
    fn from(value: worker_mounts::WorkerMountError) -> Self {
        Self::Mount(value)
    }
}
impl From<reverie_contracts::lease_policy::LeaseDataError> for WorkerValidationCause {
    fn from(value: reverie_contracts::lease_policy::LeaseDataError) -> Self {
        Self::Lease(value)
    }
}
impl WorkerValidationError {
    pub(crate) fn has_unconfirmed_close(&self) -> bool {
        match &self.cause {
            WorkerValidationCause::Native(host::WorkerValidationHostError::Observation(e)) => {
                e.has_unconfirmed_close()
            }
            WorkerValidationCause::Rootless(e) => rootless_close_unknown(e),
            _ => false,
        }
    }
    pub fn stage(&self) -> WorkerValidationStage {
        self.stage
    }
    pub fn cause(&self) -> &WorkerValidationCause {
        &self.cause
    }
    pub fn code(&self) -> &'static str {
        self.cause.code()
    }
}
pub(crate) fn rootless_close_unknown(error: &rootless::RootlessHostError) -> bool {
    use reverie_host::task_perf::TaskPerfHostError as P;
    match error {
        rootless::RootlessHostError::Observation(e)
        | rootless::RootlessHostError::Perf(P::Observation(e)) => e.has_unconfirmed_close(),
        rootless::RootlessHostError::Perf(P::Identity(e)) => e.has_unconfirmed_close(),
        _ => false,
    }
}
impl std::fmt::Display for WorkerValidationError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for WorkerValidationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl WorkerValidationStage {
    fn error(self, cause: impl Into<WorkerValidationCause>) -> WorkerValidationError {
        WorkerValidationError {
            stage: self,
            cause: cause.into(),
        }
    }
}

/// All clauses of the source worker.validate_config succeeded. The original
/// captured object is unchanged. Native facts are readonly snapshots only.
pub struct ValidatedWorkerSnapshot {
    envelope: WorkerEnvelope,
    mounts: worker_mounts::WorkerMountSources,
    source_path: Option<std::path::PathBuf>,
}
impl ValidatedWorkerSnapshot {
    pub(crate) fn validate_actor_setup_candidate(
        &self,
        candidate: &reverie_contracts::resource_actor::ActorSetupTransition,
    ) -> Result<Self> {
        self.validate_candidate_configuration(candidate.after().clone())
    }
    pub(crate) fn validate_perf_candidate(
        &self,
        candidate: &reverie_contracts::perf_transition::PerfTransition,
    ) -> Result<Self> {
        self.validate_candidate_configuration(candidate.after().clone())
    }
    pub(crate) fn validate_gpu_candidate(
        &self,
        candidate: &reverie_contracts::gpu_access::GpuCandidate,
    ) -> Result<Self> {
        self.validate_candidate_configuration(candidate.after().clone())
    }
    pub(crate) fn validate_pool_candidate(
        &self,
        candidate: &reverie_contracts::worker_pool::WorkerPoolConfigurationTransition,
    ) -> Result<Self> {
        self.validate_candidate_configuration(candidate.after().clone())
    }
    fn validate_candidate_configuration(
        &self,
        configuration: EffectiveWorkerConfig,
    ) -> Result<Self> {
        let mut next = validate_captured(configuration)?;
        next.source_path = self.source_path.clone();
        Ok(next)
    }
    /// Actual loader-selected entry data. None preserves the embedded captured
    /// configuration mode; this path is not authorization or retained custody.
    pub fn source_path(&self) -> Option<&std::path::Path> {
        self.source_path.as_deref()
    }
    pub fn envelope(&self) -> &WorkerEnvelope {
        &self.envelope
    }
    pub fn mount_sources(&self) -> &worker_mounts::WorkerMountSources {
        &self.mounts
    }
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        self.envelope.configuration()
    }
    pub fn into_configuration(self) -> EffectiveWorkerConfig {
        self.envelope.into_configuration()
    }
}
pub fn validate_captured(config: EffectiveWorkerConfig) -> Result<ValidatedWorkerSnapshot> {
    let data = WorkerValidationData::new(&config);
    use WorkerValidationStage as Stage;
    data.header().map_err(|e| Stage::Header.error(e))?;
    data.helper_and_memory()
        .map_err(|e| Stage::HelperMemory.error(e))?;
    data.reservation()
        .map_err(|e| Stage::Reservation.error(e))?;
    host::observe_ops_binding(&config).map_err(|e| Stage::Ops.error(e))?;
    host::observe_private_selector(&config, PrivateSelector::BrowserJob)
        .map_err(|e| Stage::Browser.error(e))?;
    host::observe_private_selector(&config, PrivateSelector::ResourceActor)
        .map_err(|e| Stage::ResourceActor.error(e))?;
    data.telemetry_and_maps()
        .map_err(|e| Stage::TelemetryMaps.error(e))?;
    let rootless = RootlessConfig::capture(config.clone())
        .map_err(|e| Stage::Rootless.error(rootless::RootlessHostError::Data(e)))?;
    rootless::observe_rootless(&rootless).map_err(|e| Stage::Rootless.error(e))?;
    data.goal_path().map_err(|e| Stage::Goal.error(e))?;
    let (envelope, mounts) =
        worker_mounts::capture_mount_sources(config).map_err(|e| Stage::BaseMounts.error(e))?;
    reverie_contracts::lease_policy::LeaseConfig::validate_option(envelope.configuration())
        .map_err(|e| Stage::Lease.error(e))?;
    host::observe_cold_policy(envelope.configuration()).map_err(|e| Stage::Cold.error(e))?;
    Ok(ValidatedWorkerSnapshot {
        envelope,
        mounts,
        source_path: None,
    })
}
pub fn load_owner_config(path: &std::path::Path) -> Result<ValidatedWorkerSnapshot> {
    let (config, source) = host::load_owner_configuration_with_source(path)
        .map_err(|e| WorkerValidationStage::Loader.error(e))?;
    let mut captured = validate_captured(config)?;
    captured.source_path = Some(source);
    Ok(captured)
}
