use super::*;
use std::fmt;
#[derive(Debug)]
pub enum PoolNominationError {
    Refused(&'static str),
    Io(std::io::Error),
    Journal(reverie_store::operations::JournalError),
    Native(crate::ObservationError),
    Private(crate::goal_custody::GoalCustodyError),
    Pool(crate::worker_pool::PoolError),
    Target(crate::worker_pool::PoolTargetObservationError),
    Artifact(crate::website_facts::WebsiteFactsError),
    Configuration(reverie_contracts::reservation_engine::EngineDataError),
    Data(reverie_contracts::resource_actor::ResourceActorDataError),
    Files(crate::gpu_access::GpuHostError),
    Identity(reverie_store::storage_identity::IdentityError),
    Resources(reverie_contracts::broker_resources::ResourceConfigError),
    Facts(crate::resource_facts::ResourceFactsError),
    Engine(crate::engine_metadata::EngineError),
    Runtime(crate::worker_runtime::RuntimeError),
    Service(crate::worker_service::WorkerServiceError),
    Maintenance(crate::worker_image::ImageFileError),
    Finalization(Box<Self>, Box<Self>),
}
impl PoolNominationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Io(_) => "POOL_NOMINATION_IO",
            Self::Journal(_) => "POOL_RETIRE_NAMESPACE_SCAN",
            Self::Native(e) => e.code(),
            Self::Private(e) => e.code(),
            Self::Pool(e) => e.code(),
            Self::Target(e) => e.code(),
            Self::Artifact(e) => e.code(),
            Self::Configuration(e) => e.code(),
            Self::Data(e) => e.code(),
            Self::Files(e) => e.code(),
            Self::Identity(e) => e.code(),
            Self::Resources(e) => e.code(),
            Self::Facts(e) => e.code(),
            Self::Engine(e) => e.code(),
            Self::Runtime(_) => "POOL_NOMINATION_RUNTIME_CLOSE",
            Self::Service(e) => e.code(),
            Self::Maintenance(e) => e.code(),
            Self::Finalization(primary, _) => primary.code(),
        }
    }
}
impl fmt::Display for PoolNominationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for PoolNominationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(_) => None,
            Self::Io(e) => Some(e),
            Self::Journal(e) => Some(e),
            Self::Native(e) => Some(e),
            Self::Private(e) => Some(e),
            Self::Pool(e) => Some(e),
            Self::Target(e) => Some(e),
            Self::Artifact(e) => Some(e),
            Self::Configuration(e) => Some(e),
            Self::Data(e) => Some(e),
            Self::Files(e) => Some(e),
            Self::Identity(e) => Some(e),
            Self::Resources(e) => Some(e),
            Self::Facts(e) => Some(e),
            Self::Engine(e) => Some(e),
            Self::Runtime(e) => Some(e),
            Self::Service(e) => Some(e),
            Self::Maintenance(e) => Some(e),
            Self::Finalization(primary, _) => Some(primary),
        }
    }
}
macro_rules! from_error {
    ($type:ty, $variant:ident) => {
        impl From<$type> for PoolNominationError {
            fn from(error: $type) -> Self {
                Self::$variant(error)
            }
        }
    };
}
from_error!(std::io::Error, Io);
from_error!(reverie_store::operations::JournalError, Journal);
from_error!(crate::ObservationError, Native);
from_error!(crate::goal_custody::GoalCustodyError, Private);
from_error!(crate::worker_pool::PoolError, Pool);
from_error!(crate::worker_pool::PoolTargetObservationError, Target);
from_error!(crate::website_facts::WebsiteFactsError, Artifact);
from_error!(
    reverie_contracts::reservation_engine::EngineDataError,
    Configuration
);
from_error!(
    reverie_contracts::resource_actor::ResourceActorDataError,
    Data
);
from_error!(crate::gpu_access::GpuHostError, Files);
from_error!(reverie_store::storage_identity::IdentityError, Identity);
from_error!(
    reverie_contracts::broker_resources::ResourceConfigError,
    Resources
);
from_error!(crate::resource_facts::ResourceFactsError, Facts);
from_error!(crate::engine_metadata::EngineError, Engine);
from_error!(crate::worker_runtime::RuntimeError, Runtime);
from_error!(crate::worker_service::WorkerServiceError, Service);
from_error!(crate::worker_image::ImageFileError, Maintenance);

#[must_use = "retain original metadata/runtime/publication owners; never replay a partial import"]
pub struct PoolNominationFailure {
    owner: Option<Box<NominationOwner>>,
    cause: PoolNominationError,
}
impl PoolNominationFailure {
    pub(super) fn new(owner: Box<NominationOwner>, cause: PoolNominationError) -> Self {
        Self {
            owner: Some(owner),
            cause,
        }
    }
    pub fn cause(&self) -> &PoolNominationError {
        &self.cause
    }
}
impl fmt::Debug for PoolNominationFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("PoolNominationFailure")
            .field(&self.cause)
            .finish()
    }
}
impl fmt::Display for PoolNominationFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for PoolNominationFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl Drop for PoolNominationFailure {
    fn drop(&mut self) {
        std::mem::forget(self.owner.take());
    }
}
