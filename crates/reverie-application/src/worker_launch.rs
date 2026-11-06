//! Complete request/create/tmux/account preparation. Plans bind captured domain
//! data and store-selected paths, never admission or native effect permission.
use crate::{resource_staging, worker_validation::ValidatedWorkerSnapshot};
use reverie_contracts::{
    storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig,
    worker_launch::{self, CreateArguments, LaunchDataError, WorkerRequest},
};
use reverie_core::ids::ProfileSessionId;
use reverie_host::{device_policy, rootless, worker_launch as host};
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
    Owner(reverie_host::worker_storage::StorageOwnerError),
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
            Self::Owner(_) => "LAUNCH_OWNER",
            Self::StorageSession => "LAUNCH_STORAGE_SESSION",
        })
    }
}
impl std::error::Error for LaunchPreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Data(e) => Some(e),
            Self::Effective(e) => Some(e),
            Self::Rootless(e) => Some(e),
            Self::Host(e) => Some(e),
            Self::Gpu(e) => Some(e),
            Self::Identity(e) => Some(e),
            Self::Owner(e) => Some(e),
            Self::StorageSession => None,
        }
    }
}
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
impl From<host::CreateObservationError> for LaunchPreparationError {
    fn from(error: host::CreateObservationError) -> Self {
        match error {
            host::CreateObservationError::Data(e) => Self::Data(e),
            host::CreateObservationError::Rootless(e) => Self::Rootless(e),
            host::CreateObservationError::Gpu(e) => Self::Gpu(e),
            host::CreateObservationError::Host(e) => Self::Host(e),
            host::CreateObservationError::Identity(e) => Self::Identity(e),
            host::CreateObservationError::Owner(e) => Self::Owner(e),
            host::CreateObservationError::StorageSession => Self::StorageSession,
        }
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
    if storage.session() != session {
        return Err(LaunchPreparationError::StorageSession);
    }
    let source = captured.configuration().clone();
    let effective = resource_staging::effective_config(source.clone(), session)
        .map_err(LaunchPreparationError::Effective)?;
    let arguments = host::observe_create_arguments(&effective, session, storage)?;
    Ok(WorkerCreatePlan {
        source,
        effective,
        session: session.clone(),
        storage: storage.clone(),
        arguments,
    })
}
