//! Read-side employee storage resolution. Returned facts are not leases, owner
//! grants, execution eligibility overrides or a storage publication capability.
mod metadata;
mod resolver;
#[cfg(test)]
mod tests;

use crate::StoreError;
pub use metadata::{DEFAULT_METADATA_LIMIT, canonical, read_metadata};
pub use resolver::{
    StorageIdentityConfig, StorageKind, StoragePaths, company_records, current_employee,
    storage_paths, storage_start_allowed,
};
use reverie_contracts::storage_identity::IdentityDataError;
use std::{fmt, io};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityFault {
    CanonicalPath,
    MetadataCustody,
    MetadataBound,
    MetadataChanged,
    StoredBindingConflict,
    CurrentBindingChanged,
}
impl IdentityFault {
    pub fn code(self) -> &'static str {
        match self {
            Self::CanonicalPath => "CANONICAL_STORAGE_PATH",
            Self::MetadataCustody => "TRUSTED_STORAGE_METADATA",
            Self::MetadataBound => "STORAGE_METADATA_BOUND",
            Self::MetadataChanged => "STORAGE_METADATA_CHANGED",
            Self::StoredBindingConflict => "STORED_EMPLOYEE_BINDING_CONFLICT",
            Self::CurrentBindingChanged => "CURRENT_EMPLOYEE_BINDING_CHANGED",
        }
    }
}
#[derive(Debug)]
pub enum IdentityError {
    Refused(IdentityFault),
    Io(io::Error),
    Data(IdentityDataError),
    Custody(StoreError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl IdentityError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(fault) => fault.code(),
            Self::Io(_) => "STORAGE_IDENTITY_IO",
            Self::Data(error) => error.code(),
            Self::Custody(error) => error.code(),
            Self::Finalization { .. } => "STORAGE_IDENTITY_FINALIZATION",
        }
    }
}
impl fmt::Display for IdentityError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for IdentityError {}
impl From<io::Error> for IdentityError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<IdentityDataError> for IdentityError {
    fn from(value: IdentityDataError) -> Self {
        Self::Data(value)
    }
}
type Result<T> = std::result::Result<T, IdentityError>;
fn need(value: bool, fault: IdentityFault) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(IdentityError::Refused(fault))
    }
}
fn finalized<T>(value: Result<T>, close: crate::error::Result<()>) -> Result<T> {
    match (value, close) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(IdentityError::Custody(error)),
        (Err(primary), Err(secondary)) => Err(IdentityError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(IdentityError::Custody(secondary)),
        }),
    }
}
