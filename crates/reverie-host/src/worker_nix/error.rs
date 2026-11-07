use crate::{ObservationError, worker_storage::StorageError};
use reverie_contracts::worker_nix::NixDataError;
use reverie_store::storage_identity::IdentityError;
use std::{fmt, io};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NixFault {
    DurableRoot,
    Lock,
    Busy,
    Closed,
    MigrationFence,
    EmployeeFence,
    RollbackMissing,
    LegacyStore,
    StoreBinding,
    RuntimeBinding,
    Capacity,
    Retained,
    Replayed,
    Cancelled,
    Deadline,
    EngineFailed,
    UnknownCreate,
    HelperFailed,
    ImageQualification,
}
#[derive(Debug)]
pub enum NixError {
    Refused(NixFault),
    Io(io::Error),
    Data(NixDataError),
    Identity(IdentityError),
    Storage(StorageError),
    Observation(ObservationError),
    Engine(crate::engine_metadata::EngineError),
    Owner(crate::worker_storage::StorageOwnerError),
    Intent(crate::worker_intent::IntentHostError),
    Rootless(crate::rootless::RootlessHostError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    PartialEffects(Box<Self>),
}
impl fmt::Display for NixError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "NIX_STORE: {self:?}")
    }
}
impl std::error::Error for NixError {}
impl From<io::Error> for NixError {
    fn from(v: io::Error) -> Self {
        Self::Io(v)
    }
}
impl From<NixDataError> for NixError {
    fn from(v: NixDataError) -> Self {
        Self::Data(v)
    }
}
impl From<IdentityError> for NixError {
    fn from(v: IdentityError) -> Self {
        Self::Identity(v)
    }
}
impl From<StorageError> for NixError {
    fn from(v: StorageError) -> Self {
        Self::Storage(v)
    }
}
impl From<ObservationError> for NixError {
    fn from(v: ObservationError) -> Self {
        Self::Observation(v)
    }
}
impl From<crate::engine_metadata::EngineError> for NixError {
    fn from(error: crate::engine_metadata::EngineError) -> Self {
        Self::Engine(error)
    }
}
impl From<crate::worker_storage::StorageOwnerError> for NixError {
    fn from(error: crate::worker_storage::StorageOwnerError) -> Self {
        Self::Owner(error)
    }
}
impl From<crate::worker_intent::IntentHostError> for NixError {
    fn from(error: crate::worker_intent::IntentHostError) -> Self {
        Self::Intent(error)
    }
}
impl From<crate::rootless::RootlessHostError> for NixError {
    fn from(error: crate::rootless::RootlessHostError) -> Self {
        Self::Rootless(error)
    }
}
pub(super) type Result<T> = std::result::Result<T, NixError>;
pub(super) fn need(value: bool, fault: NixFault) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(NixError::Refused(fault))
    }
}
pub(super) fn finalized<T>(result: Result<T>, close: Result<()>) -> Result<T> {
    match (result, close) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), Ok(())) | (Ok(_), Err(e)) => Err(e),
        (Err(primary), Err(secondary)) => Err(NixError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
pub(super) fn partial<T>(result: Result<T>, effects: bool) -> Result<T> {
    result.map_err(|e| {
        if effects {
            NixError::PartialEffects(Box::new(e))
        } else {
            e
        }
    })
}
