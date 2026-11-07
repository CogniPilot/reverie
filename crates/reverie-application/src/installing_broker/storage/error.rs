use super::*;
use std::{error::Error, fmt};
#[derive(Debug)]
enum Cause {
    Office(reverie_host::office::OfficeError),
    SourceStop(Box<reverie_host::worker_source_stop::SourceStopError>),
    Gate(GateError),
    Owner(StorageOwnerError),
    Laptop(Box<reverie_host::worker_laptop::LaptopError>),
    Refused(&'static str),
}
#[derive(Debug)]
pub struct StorageWorkflowError {
    primary: Cause,
    cleanup: Vec<StorageOwnerError>,
}
impl StorageWorkflowError {
    /// Original claim_storage's BlockingIOError branch only. A cleanup failure
    /// is not a waitable refusal, even when its primary fault was a busy lease.
    pub(in crate::installing_broker) fn wait_busy(&self) -> bool {
        if !self.cleanup.is_empty() {
            return false;
        }
        match &self.primary {
            Cause::Refused("WORKER_PREVIOUS_EMPLOYEE_STORAGE_BUSY") => true,
            Cause::Owner(StorageOwnerError::Storage(error)) => storage_busy(error),
            _ => false,
        }
    }
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
            Cause::Office(_) => "RESOURCE_ORIGINAL_OFFICE_CLOSE_UNCONFIRMED",
            Cause::SourceStop(error) => error.code(),
            Cause::Gate(error) => error.code(),
            Cause::Owner(error) => error.code(),
            Cause::Laptop(error) => error.code(),
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
fn storage_busy(error: &reverie_host::worker_storage::StorageError) -> bool {
    use reverie_host::worker_storage::{StorageError, StorageFault};
    match error {
        StorageError::Refused(StorageFault::LeaseBusy) => true,
        StorageError::PartialEffects(primary) => storage_busy(primary),
        _ => false,
    }
}
impl From<reverie_host::office::OfficeError> for StorageWorkflowError {
    fn from(error: reverie_host::office::OfficeError) -> Self {
        Self {
            primary: Cause::Office(error),
            cleanup: Vec::new(),
        }
    }
}
impl From<reverie_host::worker_source_stop::SourceStopError> for StorageWorkflowError {
    fn from(error: reverie_host::worker_source_stop::SourceStopError) -> Self {
        Self {
            primary: Cause::SourceStop(Box::new(error)),
            cleanup: vec![],
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
impl From<reverie_host::worker_laptop::LaptopError> for StorageWorkflowError {
    fn from(error: reverie_host::worker_laptop::LaptopError) -> Self {
        Self {
            primary: Cause::Laptop(Box::new(error)),
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
            Cause::Office(error) => Some(error),
            Cause::SourceStop(error) => Some(error.as_ref()),
            Cause::Gate(error) => Some(error),
            Cause::Owner(error) => Some(error),
            Cause::Laptop(error) => Some(error.as_ref()),
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
