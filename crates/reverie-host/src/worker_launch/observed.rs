//! One actual native create-argument observation owner. Its immutable results
//! remain data; effects also require real resource custody and App admission.
use super::*;
use crate::{
    device_policy,
    installed_worker_engine::InstalledWorkerEngine,
    worker_identity,
    worker_runtime::WorkerRuntime,
    worker_storage::{LaunchStorage, StorageOwnerError},
};
use reverie_contracts::{
    device_policy::gpu,
    resource_config::ResourceConfiguration,
    worker_launch::{CreateArguments, CreateObservations, CreatePreparation},
};
use reverie_core::ids::ProfileSessionId;
use std::sync::Arc;
#[cfg(test)]
mod tests;
#[derive(Debug)]
pub enum CreateObservationError {
    Data(LaunchDataError),
    Rootless(rootless::RootlessHostError),
    Gpu(device_policy::DevicePolicyHostError),
    Host(LaunchHostError),
    Identity(storage_identity::IdentityError),
    Owner(StorageOwnerError),
    StorageSession,
}
impl std::fmt::Display for CreateObservationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Data(_) => "LAUNCH_DATA",
            Self::Rootless(_) => "LAUNCH_ROOTLESS",
            Self::Gpu(_) => "LAUNCH_GPU",
            Self::Host(_) => "LAUNCH_HOST",
            Self::Identity(_) => "LAUNCH_IDENTITY",
            Self::Owner(_) => "LAUNCH_OWNER",
            Self::StorageSession => "LAUNCH_STORAGE_SESSION",
        })
    }
}
impl std::error::Error for CreateObservationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Data(e) => Some(e),
            Self::Rootless(e) => Some(e),
            Self::Gpu(e) => Some(e),
            Self::Host(e) => Some(e),
            Self::Identity(e) => Some(e),
            Self::Owner(e) => Some(e),
            Self::StorageSession => None,
        }
    }
}
impl From<LaunchDataError> for CreateObservationError {
    fn from(e: LaunchDataError) -> Self {
        Self::Data(e)
    }
}
impl From<rootless::RootlessHostError> for CreateObservationError {
    fn from(e: rootless::RootlessHostError) -> Self {
        Self::Rootless(e)
    }
}
impl From<device_policy::DevicePolicyHostError> for CreateObservationError {
    fn from(e: device_policy::DevicePolicyHostError) -> Self {
        Self::Gpu(e)
    }
}
impl From<LaunchHostError> for CreateObservationError {
    fn from(e: LaunchHostError) -> Self {
        Self::Host(e)
    }
}
impl From<storage_identity::IdentityError> for CreateObservationError {
    fn from(e: storage_identity::IdentityError) -> Self {
        Self::Identity(e)
    }
}
impl From<StorageOwnerError> for CreateObservationError {
    fn from(e: StorageOwnerError) -> Self {
        Self::Owner(e)
    }
}
type Result<T> = std::result::Result<T, CreateObservationError>;

/// Produced by the actual observation sequence over one existing Runtime and
/// its real storage owner. This cannot be decoded or built from argv/reply DATA.
/// Same-origin provenance is NOT owner authorization or permission to start.
pub struct ObservedCreatePlan {
    origin: Arc<InstalledWorkerEngine>,
    source: EffectiveWorkerConfig,
    effective: EffectiveWorkerConfig,
    session: ProfileSessionId,
    storage: StoragePaths,
    arguments: CreateArguments,
}
impl ObservedCreatePlan {
    pub fn same_runtime(&self, runtime: &WorkerRuntime) -> bool {
        Arc::ptr_eq(&self.origin, runtime.installed_engine())
    }
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
}
impl WorkerRuntime {
    /// No runner capture or current-config publication occurs here. Effective
    /// config resolution remains with the App's existing resolver. Binding is
    /// pure and may not add a fresh metadata/FD observation before hashes.
    pub fn prepare_laptop_plan(
        &self,
        source: EffectiveWorkerConfig,
        effective: EffectiveWorkerConfig,
        storage: &LaunchStorage,
    ) -> Result<ObservedCreatePlan> {
        let session = storage.paths().session();
        storage.assert_binding(self, &source, session)?;
        storage.assert_binding(self, &effective, session)?;
        let arguments = observe_create_arguments(&effective, session, storage.paths())?;
        Ok(ObservedCreatePlan {
            origin: self.installed_engine().clone(),
            source,
            effective,
            session: session.clone(),
            storage: storage.paths().clone(),
            arguments,
        })
    }
}
/// Compatibility/read-side DATA entrypoint. This does not produce a same-
/// Runtime observed plan and cannot replace real resource/effect ownership.
pub fn observe_create_arguments(
    effective: &EffectiveWorkerConfig,
    session: &ProfileSessionId,
    storage: &StoragePaths,
) -> Result<CreateArguments> {
    observe_with(effective, session, storage, &Installed)
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
        Ok(super::employee_hostname(config, storage)?)
    }
}
fn observe_with(
    effective: &EffectiveWorkerConfig,
    session: &ProfileSessionId,
    storage: &StoragePaths,
    observed: &impl Source,
) -> Result<CreateArguments> {
    if storage.session() != session {
        return Err(CreateObservationError::StorageSession);
    }
    let prepared = CreatePreparation::capture(effective, session)?;
    let rootless =
        RootlessConfig::capture(effective.clone()).map_err(rootless::RootlessHostError::from)?;
    // Preserve both fresh reads and late hostname metadata in original order.
    let security = observed.rootless(&rootless)?;
    let runtime = observed.rootless(&rootless)?;
    let gpu = observed.gpu(effective, session)?;
    let hostname = observed.hostname(effective, storage)?;
    let paths = super::storage_argument_paths(storage)?;
    Ok(prepared.arguments(
        &paths.0,
        Some(&paths.1),
        CreateObservations {
            security: security.security_args(),
            runtime: runtime.runtime_args(),
            gpu: &gpu,
            employee: storage.employee().zip(hostname.as_deref()),
        },
    )?)
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
