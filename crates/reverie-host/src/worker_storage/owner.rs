//! Actual service-produced storage resources. These are not API/start grants.
use super::*;
use crate::{
    engine_metadata::EngineError, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use reverie_contracts::{storage_writers::WriterDataError, worker_storage::StorageConfiguration};
use reverie_store::storage_identity::IdentityError;
use std::{fmt, sync::Arc, time::Instant};

#[derive(Debug)]
pub enum StorageOwnerError {
    Storage(StorageError),
    Identity(IdentityError),
    Engine(EngineError),
    Data(WriterDataError),
    Settings(reverie_contracts::broker_resources::ResourceConfigError),
    Intent(reverie_contracts::worker_intent::IntentDataError),
    Path(std::io::Error),
    Refused(&'static str),
    Finalized {
        primary: Box<Self>,
        secondary: Vec<Self>,
    },
}
impl StorageOwnerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Storage(_) => "WORKER_STORAGE_RESOURCE",
            Self::Identity(error) => error.code(),
            Self::Engine(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Settings(_) => "WORKER_STORAGE_SETTINGS",
            Self::Intent(error) => error.code(),
            Self::Path(_) => "WORKER_STORAGE_NATIVE_PATH",
            Self::Refused(code) => code,
            Self::Finalized { primary, .. } => primary.code(),
        }
    }
    pub fn cleanup_errors(&self) -> &[Self] {
        match self {
            Self::Finalized { secondary, .. } => secondary,
            _ => &[],
        }
    }
}
impl fmt::Display for StorageOwnerError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for StorageOwnerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(error) => Some(error),
            Self::Identity(error) => Some(error),
            Self::Engine(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Settings(error) => Some(error),
            Self::Intent(error) => Some(error),
            Self::Path(error) => Some(error),
            Self::Refused(_) => None,
            Self::Finalized { primary, .. } => Some(primary.as_ref()),
        }
    }
}
type OwnerResult<T> = std::result::Result<T, StorageOwnerError>;
#[cfg(test)]
thread_local! {pub(super) static BEFORE_CONSUMPTION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);}
#[derive(Clone, Eq, PartialEq)]
struct Namespace {
    company: MetadataText,
    state: MetadataText,
    scratch: MetadataText,
}
impl Namespace {
    fn capture(source: &EffectiveWorkerConfig) -> OwnerResult<Self> {
        let settings = ResourceIdentitySettings::capture_worker_config(source)
            .map_err(StorageOwnerError::Settings)?;
        Ok(Self {
            company: settings.company_file().clone(),
            state: settings.state_root().clone(),
            scratch: settings.scratch_root().clone(),
        })
    }
}
/// Actual resolver result bound to the selected configuration/session and the
/// existing runtime capture. It cannot be constructed from arbitrary paths.
pub struct StorageSelection {
    engine: Arc<InstalledWorkerEngine>,
    source: EffectiveWorkerConfig,
    namespace: Namespace,
    paths: StoragePaths,
}
impl StorageSelection {
    pub(super) fn assert_runtime(&self, runtime: &WorkerRuntime) -> OwnerResult<()> {
        if !Arc::ptr_eq(&self.engine, runtime.installed_engine()) {
            return Err(StorageOwnerError::Refused(
                "WORKER_STORAGE_RUNTIME_BINDING_CHANGED",
            ));
        }
        Ok(())
    }
    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }
    pub fn source_configuration(&self) -> &EffectiveWorkerConfig {
        &self.source
    }
    /// The original Broker's no-lease branch. No lock/registry insertion or
    /// native writer check is manufactured for a genuine legacy resolution.
    pub fn into_legacy(self) -> OwnerResult<LaunchStorage> {
        if self.paths.kind() != storage_identity::StorageKind::Session {
            return Err(StorageOwnerError::Refused(
                "WORKER_EMPLOYEE_STORAGE_LEASE_REQUIRED",
            ));
        }
        Ok(LaunchStorage {
            engine: self.engine,
            source: self.source,
            namespace: self.namespace,
            paths: self.paths,
            ownership: Ownership::UnleasedLegacy,
        })
    }
    /// Source guard acquisition performs its OWN fresh resolution. Do not
    /// silently require that its resulting identity/kind equals the first read.
    pub fn acquire(self) -> std::result::Result<LaunchStorage, Box<StorageAcquireFailure>> {
        if self.paths.kind() != storage_identity::StorageKind::Employee {
            return Err(Box::new(StorageAcquireFailure {
                selection: self,
                cause: StorageOwnerError::Refused("WORKER_LEGACY_STORAGE_HAS_NO_BROKER_LEASE"),
            }));
        }
        match StorageLease::acquire_launch(&self.source, self.paths.session()) {
            Ok(lease) => Ok(LaunchStorage {
                paths: lease.paths().clone(),
                engine: self.engine,
                source: self.source,
                namespace: self.namespace,
                ownership: Ownership::Held(Box::new(lease)),
            }),
            Err(error) => Err(Box::new(StorageAcquireFailure {
                selection: self,
                cause: StorageOwnerError::Storage(error),
            })),
        }
    }
}
pub struct StorageAcquireFailure {
    selection: StorageSelection,
    cause: StorageOwnerError,
}
impl StorageAcquireFailure {
    pub fn into_parts(self: Box<Self>) -> (StorageSelection, StorageOwnerError) {
        (self.selection, self.cause)
    }
    pub fn cause(&self) -> &StorageOwnerError {
        &self.cause
    }
}
impl fmt::Debug for StorageAcquireFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_tuple("StorageAcquireFailure")
            .field(&self.cause.code())
            .finish()
    }
}
impl fmt::Display for StorageAcquireFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for StorageAcquireFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

enum Ownership {
    Held(Box<StorageLease>),
    UnleasedLegacy,
    ConsumedUnconfirmed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageOwnershipKind {
    HeldLease,
    UnleasedLegacy,
    ConsumedUnconfirmed,
}
/// Move-only lifetime resources, never a native launch/authorization permit.
/// A genuine legacy result owns paths DATA and no fabricated no-op lease.
pub struct LaunchStorage {
    engine: Arc<InstalledWorkerEngine>,
    source: EffectiveWorkerConfig,
    namespace: Namespace,
    paths: StoragePaths,
    ownership: Ownership,
}
impl LaunchStorage {
    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }
    pub fn source_configuration(&self) -> &EffectiveWorkerConfig {
        &self.source
    }
    pub fn ownership_kind(&self) -> StorageOwnershipKind {
        match self.ownership {
            Ownership::Held(_) => StorageOwnershipKind::HeldLease,
            Ownership::UnleasedLegacy => StorageOwnershipKind::UnleasedLegacy,
            Ownership::ConsumedUnconfirmed => StorageOwnershipKind::ConsumedUnconfirmed,
        }
    }
    /// Pure provenance/namespace check, suitable before image opt-out. It does
    /// not re-read metadata or freeze mutable image/resource settings.
    pub fn assert_binding(
        &self,
        runtime: &WorkerRuntime,
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> OwnerResult<()> {
        if !Arc::ptr_eq(&self.engine, runtime.installed_engine())
            || self.paths.session() != session
            || !StorageConfiguration::capture(source)
                .matches_service_namespace(runtime.worker_identity())
            || Namespace::capture(source)? != self.namespace
        {
            return Err(StorageOwnerError::Refused(
                "WORKER_STORAGE_RUNTIME_BINDING_CHANGED",
            ));
        }
        if matches!(self.ownership, Ownership::ConsumedUnconfirmed) {
            return Err(StorageOwnerError::Refused(
                "WORKER_STORAGE_CLOSE_UNCONFIRMED",
            ));
        }
        Ok(())
    }
    /// Explicitly reports legacy absence, never claims an imaginary lease.
    /// Call only at the enabled phase: the real held check performs FD I/O.
    pub fn check_resource_current(&self) -> OwnerResult<StorageOwnershipKind> {
        match &self.ownership {
            Ownership::Held(lease) => {
                lease.assert_current().map_err(StorageOwnerError::Storage)?;
                Ok(StorageOwnershipKind::HeldLease)
            }
            Ownership::UnleasedLegacy => Ok(StorageOwnershipKind::UnleasedLegacy),
            Ownership::ConsumedUnconfirmed => Err(StorageOwnerError::Refused(
                "WORKER_STORAGE_CLOSE_UNCONFIRMED",
            )),
        }
    }
    /// Close only after the SAME constructor/client/pipe work is confirmed
    /// settled. Failure returns the actual resource owner; a consumed uncertain
    /// descriptor is never retried or reconstructed as a live/no-op lease.
    pub fn close(mut self, deadline: Instant) -> std::result::Result<(), Box<StorageCloseFailure>> {
        if matches!(self.ownership, Ownership::ConsumedUnconfirmed) {
            return Err(Box::new(StorageCloseFailure {
                owner: self,
                cause: StorageOwnerError::Refused("WORKER_STORAGE_CLOSE_UNCONFIRMED"),
            }));
        }
        if let Err(error) = self.engine.settle_owned(deadline) {
            return Err(Box::new(StorageCloseFailure {
                owner: self,
                cause: StorageOwnerError::Engine(error),
            }));
        }
        #[cfg(test)]
        BEFORE_CONSUMPTION.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook();
            }
        });
        let ownership = std::mem::replace(&mut self.ownership, Ownership::ConsumedUnconfirmed);
        let closed = match ownership {
            Ownership::Held(lease) => lease.close().map_err(StorageOwnerError::Storage),
            Ownership::UnleasedLegacy => Ok(()),
            Ownership::ConsumedUnconfirmed => unreachable!("checked above"),
        };
        // A new query can be admitted after the first settlement. A constructor
        // admitted before FD consumption must also settle before this owner
        // acknowledges release. This inventories only this captured context;
        // unrelated process producers remain the installing broker's duty.
        let settled = self
            .engine
            .settle_owned(deadline)
            .map_err(StorageOwnerError::Engine);
        let result = match (closed, settled) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Err(secondary)) => Err(StorageOwnerError::Finalized {
                primary: Box::new(primary),
                secondary: vec![secondary],
            }),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        };
        result.map_err(|cause| Box::new(StorageCloseFailure { owner: self, cause }))
    }
}
pub struct StorageCloseFailure {
    owner: LaunchStorage,
    cause: StorageOwnerError,
}
impl StorageCloseFailure {
    pub fn into_parts(self: Box<Self>) -> (LaunchStorage, StorageOwnerError) {
        (self.owner, self.cause)
    }
    pub fn cause(&self) -> &StorageOwnerError {
        &self.cause
    }
}
impl fmt::Debug for StorageCloseFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_tuple("StorageCloseFailure")
            .field(&self.cause.code())
            .finish()
    }
}
impl fmt::Display for StorageCloseFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for StorageCloseFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl WorkerRuntime {
    /// Actual installing-source resolution. Configuration is selected DATA;
    /// only the application's current validated snapshot may supply it. This
    /// library resource factory itself confers no API/start authority.
    pub fn resolve_storage(
        &self,
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> OwnerResult<StorageSelection> {
        let data = StorageConfiguration::capture(source);
        if !data.matches_service_namespace(self.worker_identity()) {
            return Err(StorageOwnerError::Refused(
                "WORKER_STORAGE_SERVICE_NAMESPACE",
            ));
        }
        let settings = data
            .identity_settings()
            .map_err(StorageOwnerError::Settings)?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        let paths = storage_identity::storage_paths(&identity, session)
            .map_err(StorageOwnerError::Identity)?;
        Ok(StorageSelection {
            engine: self.installed_engine().clone(),
            source: source.clone(),
            namespace: Namespace::capture(source)?,
            paths,
        })
    }
}
