use super::*;
use std::{error::Error, fmt};
#[derive(Debug)]
enum Cause {
    Gate(GateError),
    Owner(StorageOwnerError),
    Refused(&'static str),
}
#[derive(Debug)]
pub struct StorageWorkflowError {
    primary: Cause,
    cleanup: Vec<StorageOwnerError>,
}
impl StorageWorkflowError {
    pub(super) fn refused(code: &'static str) -> Self {
        Self {
            primary: Cause::Refused(code),
            cleanup: Vec::new(),
        }
    }
    pub(super) fn with_cleanup(primary: StorageOwnerError, cleanup: StorageOwnerError) -> Self {
        Self {
            primary: Cause::Owner(primary),
            cleanup: vec![cleanup],
        }
    }
    pub fn code(&self) -> &'static str {
        match &self.primary {
            Cause::Gate(error) => error.code(),
            Cause::Owner(error) => error.code(),
            Cause::Refused(code) => code,
        }
    }
    pub fn cleanup_errors(&self) -> &[StorageOwnerError] {
        &self.cleanup
    }
    pub fn owner_error(&self) -> Option<&StorageOwnerError> {
        match &self.primary {
            Cause::Owner(error) => Some(error),
            _ => None,
        }
    }
    pub fn gate_error(&self) -> Option<&GateError> {
        match &self.primary {
            Cause::Gate(error) => Some(error),
            _ => None,
        }
    }
}
impl From<GateError> for StorageWorkflowError {
    fn from(error: GateError) -> Self {
        Self {
            primary: Cause::Gate(error),
            cleanup: Vec::new(),
        }
    }
}
impl From<StorageOwnerError> for StorageWorkflowError {
    fn from(error: StorageOwnerError) -> Self {
        Self {
            primary: Cause::Owner(error),
            cleanup: Vec::new(),
        }
    }
}
impl fmt::Display for StorageWorkflowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl Error for StorageWorkflowError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match &self.primary {
            Cause::Gate(error) => Some(error),
            Cause::Owner(error) => Some(error),
            Cause::Refused(_) => None,
        }
    }
}
pub struct StorageReleaseFailure {
    pub(super) claim: StorageClaim,
    pub(super) cause: StorageWorkflowError,
}
impl StorageReleaseFailure {
    pub fn into_parts(self: Box<Self>) -> (StorageClaim, StorageWorkflowError) {
        (self.claim, self.cause)
    }
    pub fn cause(&self) -> &StorageWorkflowError {
        &self.cause
    }
}
impl fmt::Debug for StorageReleaseFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("StorageReleaseFailure")
            .field(&self.cause)
            .finish()
    }
}
impl fmt::Display for StorageReleaseFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.cause.fmt(f)
    }
}
impl Error for StorageReleaseFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.cause)
    }
}
