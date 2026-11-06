use reverie_contracts::{
    broker_resources::ResourceConfigError, storage_identity::IdentityDataError,
};
use reverie_store::storage_identity::IdentityError;
use std::{fmt, io};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageFault {
    CanonicalPath,
    SharedState,
    PrivateDirectory,
    LockCustody,
    LeaseBusy,
    MigrationFence,
    BindingChanged,
    PairedMigration,
    ReadyMarker,
    CurrentBinding,
    StoredLineage,
    DirectoryChanged,
    ClosedLease,
}
#[derive(Debug)]
pub enum StorageError {
    Refused(StorageFault),
    Io(io::Error),
    Identity(IdentityError),
    Data(IdentityDataError),
    Settings(ResourceConfigError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    /// Some directory/lock/publication effects may already exist. No rollback
    /// or unchanged-filesystem claim accompanies this error.
    PartialEffects(Box<Self>),
}
impl StorageError {
    pub fn may_have_effects(&self) -> bool {
        match self {
            Self::PartialEffects(_) => true,
            Self::Finalization { primary, secondary } => {
                primary.may_have_effects() || secondary.may_have_effects()
            }
            _ => false,
        }
    }
}
impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "STORAGE_LEASE: {self:?}")
    }
}
impl std::error::Error for StorageError {}
impl From<io::Error> for StorageError {
    fn from(v: io::Error) -> Self {
        Self::Io(v)
    }
}
impl From<IdentityError> for StorageError {
    fn from(v: IdentityError) -> Self {
        Self::Identity(v)
    }
}
impl From<IdentityDataError> for StorageError {
    fn from(v: IdentityDataError) -> Self {
        Self::Data(v)
    }
}
impl From<ResourceConfigError> for StorageError {
    fn from(v: ResourceConfigError) -> Self {
        Self::Settings(v)
    }
}
impl From<crate::ObservationError> for StorageError {
    fn from(v: crate::ObservationError) -> Self {
        match v {
            crate::ObservationError::Io(v) => Self::Io(v),
            crate::ObservationError::Finalization { primary, secondary } => Self::Finalization {
                primary: Box::new(Self::from(*primary)),
                secondary: Box::new(Self::from(*secondary)),
            },
            _ => Self::Refused(StorageFault::DirectoryChanged),
        }
    }
}
pub(super) type Result<T> = std::result::Result<T, StorageError>;
pub(super) fn need(value: bool, fault: StorageFault) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(StorageError::Refused(fault))
    }
}
pub(super) fn finalized<T>(result: Result<T>, close: Result<()>) -> Result<T> {
    match (result, close) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(StorageError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
pub(super) fn partial<T>(result: Result<T>, effects: bool) -> Result<T> {
    result.map_err(|e| {
        if effects {
            StorageError::PartialEffects(Box::new(e))
        } else {
            e
        }
    })
}
