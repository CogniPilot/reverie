//! Complete request/create/tmux/account preparation. Plans bind captured domain
//! data and store-selected paths, never admission or native effect permission.
use crate::{resource_staging, worker_validation::ValidatedWorkerSnapshot};
use reverie_contracts::{
    device_policy::gpu,
    resource_config::ResourceConfiguration,
    rootless::RootlessConfig,
    storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig,
    worker_launch::{
        self, CreateArguments, CreateObservations, CreatePreparation, LaunchDataError,
        WorkerRequest,
    },
};
use reverie_core::ids::ProfileSessionId;
use reverie_host::{device_policy, rootless, worker_identity, worker_launch as host};
use reverie_store::storage_identity::{IdentityError, StoragePaths};
#[cfg(test)]
mod tests;

#[derive(Debug)]
pub enum LaunchPreparationError {
    Data(LaunchDataError),
    Effective(resource_staging::ResourceServiceError),
    Rootless(rootless::RootlessHostError),
    Host(host::LaunchHostError),
    Gpu(device_policy::DevicePolicyHostError),
    Identity(IdentityError),
    StorageSession,
}
impl std::fmt::Display for LaunchPreparationError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::Data(_) => "LAUNCH_DATA",
            Self::Effective(_) => "LAUNCH_EFFECTIVE",
            Self::Rootless(_) => "LAUNCH_ROOTLESS",
            Self::Host(_) => "LAUNCH_HOST",
            Self::Gpu(_) => "LAUNCH_GPU",
            Self::Identity(_) => "LAUNCH_IDENTITY",
            Self::StorageSession => "LAUNCH_STORAGE_SESSION",
        })
    }
}
impl std::error::Error for LaunchPreparationError {}
impl From<LaunchDataError> for LaunchPreparationError {
    fn from(value: LaunchDataError) -> Self {
        Self::Data(value)
    }
}
impl From<rootless::RootlessHostError> for LaunchPreparationError {
    fn from(value: rootless::RootlessHostError) -> Self {
        Self::Rootless(value)
    }
}
impl From<host::LaunchHostError> for LaunchPreparationError {
    fn from(value: host::LaunchHostError) -> Self {
        Self::Host(value)
    }
}
impl From<device_policy::DevicePolicyHostError> for LaunchPreparationError {
    fn from(value: device_policy::DevicePolicyHostError) -> Self {
        Self::Gpu(value)
    }
}
impl From<IdentityError> for LaunchPreparationError {
    fn from(value: IdentityError) -> Self {
        Self::Identity(value)
    }
}
type Result<T> = std::result::Result<T, LaunchPreparationError>;

/// An immutable create-argv snapshot, not an effect permit. The consuming
/// broker must preserve Gate admission/storage custody and recheck immediately
/// before effects; this plan cannot manufacture either proof.
pub struct WorkerCreatePlan {
    source: EffectiveWorkerConfig,
    effective: EffectiveWorkerConfig,
    session: ProfileSessionId,
    storage: StoragePaths,
    arguments: CreateArguments,
}
impl WorkerCreatePlan {
    pub fn source(&self) -> &EffectiveWorkerConfig {
        &self.source
    }
    pub fn effective_configuration(&self) -> &EffectiveWorkerConfig {
        &self.effective
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn storage(&self) -> &StoragePaths {
        &self.storage
    }
    pub fn arguments(&self) -> &CreateArguments {
        &self.arguments
    }
    pub fn tmux_args(&self, command: &[MetadataText], attach: bool) -> Vec<MetadataText> {
        worker_launch::tmux_exec_args(
            &reverie_core::worker_launch::ContainerReference::Worker(self.arguments.worker_name()),
            command,
            attach,
        )
    }
    /// The source validates account mounts against the ORIGINAL configuration,
    /// later than create preparation. Do not substitute projected perf data.
    pub fn account_mounts(&self, request: &WorkerRequest) -> Result<Vec<MetadataText>> {
        if request.session() != &self.session {
            return Err(LaunchPreparationError::StorageSession);
        }
        Ok(host::account_mounts(&self.source, request.environment())?)
    }
}
pub fn validate_request(raw: &[u8], captured: &ValidatedWorkerSnapshot) -> Result<WorkerRequest> {
    Ok(WorkerRequest::decode(raw, captured.configuration())?)
}

/// StoragePaths comes from the installing broker's admitted storage context and
/// is retained unchanged; do not resolve/infer a caller EID or replace its paths.
pub fn prepare_create(
    captured: &ValidatedWorkerSnapshot,
    session: &ProfileSessionId,
    storage: &StoragePaths,
) -> Result<WorkerCreatePlan> {
    prepare_observing(captured, session, storage, &Installed)
}
trait Source {
    fn rootless(&self, config: &RootlessConfig) -> Result<rootless::RootlessObservation>;
    fn gpu(
        &self,
        config: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<Vec<String>>;
    fn hostname(
        &self,
        config: &EffectiveWorkerConfig,
        storage: &StoragePaths,
    ) -> Result<Option<String>>;
}
struct Installed;
impl Source for Installed {
    fn rootless(&self, config: &RootlessConfig) -> Result<rootless::RootlessObservation> {
        Ok(rootless::observe_rootless(config)?)
    }
    fn gpu(
        &self,
        config: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<Vec<String>> {
        gpu_arguments(config, session)
    }
    fn hostname(
        &self,
        config: &EffectiveWorkerConfig,
        storage: &StoragePaths,
    ) -> Result<Option<String>> {
        Ok(host::employee_hostname(config, storage)?)
    }
}
fn prepare_observing(
    captured: &ValidatedWorkerSnapshot,
    session: &ProfileSessionId,
    storage: &StoragePaths,
    observed: &impl Source,
) -> Result<WorkerCreatePlan> {
    if storage.session() != session {
        return Err(LaunchPreparationError::StorageSession);
    }
    let source = captured.configuration().clone();
    let effective = resource_staging::effective_config(source.clone(), session)
        .map_err(LaunchPreparationError::Effective)?;
    let prepared = CreatePreparation::capture(&effective, session)?;
    let rootless =
        RootlessConfig::capture(effective.clone()).map_err(rootless::RootlessHostError::from)?;
    // Preserve TWO fresh profile observations, matching security_args then
    // runtime_args. This snapshot is not durable profile/cgroup custody.
    let security = observed.rootless(&rootless)?;
    let runtime = observed.rootless(&rootless)?;
    let gpu = observed.gpu(&effective, session)?;
    // Human hostname metadata is read last, after GPU qualification.
    let hostname = observed.hostname(&effective, storage)?;
    let paths = host::storage_argument_paths(storage)?;
    let employee = storage.employee().zip(hostname.as_deref());
    let arguments = prepared.arguments(
        &paths.0,
        Some(&paths.1),
        CreateObservations {
            security: security.security_args(),
            runtime: runtime.runtime_args(),
            gpu: &gpu,
            employee,
        },
    )?;
    Ok(WorkerCreatePlan {
        source,
        effective,
        session: session.clone(),
        storage: storage.clone(),
        arguments,
    })
}
fn gpu_arguments(
    config: &EffectiveWorkerConfig,
    session: &ProfileSessionId,
) -> Result<Vec<String>> {
    let policies =
        gpu::validate_config(config).map_err(device_policy::DevicePolicyHostError::from)?;
    if !policies.needs_current_employee(session) {
        return Ok(gpu::gpu_create_args(&policies, session, None)
            .map_err(device_policy::DevicePolicyHostError::from)?);
    }
    let captured = ResourceConfiguration::capture(config.clone())
        .map_err(device_policy::DevicePolicyHostError::from)?;
    let identity = worker_identity::storage_identity(
        &captured
            .identity_settings()
            .map_err(device_policy::DevicePolicyHostError::from)?,
    )?;
    Ok(device_policy::gpu_create_args(config, &identity, session)?)
}
