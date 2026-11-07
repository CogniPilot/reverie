use super::*;
use std::{error::Error, fmt};
#[derive(Debug)]
pub enum NixStorageError {
    Storage(StorageWorkflowError),
    Nix(NixError),
    Refused(&'static str),
}
impl NixStorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Storage(e) => e.code(),
            Self::Nix(_) => "WORKER_NIX_STORAGE",
            Self::Refused(code) => code,
        }
    }
}
impl From<StorageWorkflowError> for NixStorageError {
    fn from(e: StorageWorkflowError) -> Self {
        Self::Storage(e)
    }
}
impl From<NixError> for NixStorageError {
    fn from(e: NixError) -> Self {
        Self::Nix(e)
    }
}
impl fmt::Display for NixStorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl Error for NixStorageError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Storage(e) => Some(e),
            Self::Nix(e) => Some(e),
            Self::Refused(_) => None,
        }
    }
}
#[must_use = "restore actual guard and claim after definite retention failure"]
pub struct NixStorageRetainFailure {
    pub(super) claim: StorageClaim,
    pub(super) guard: NixStoreGuard,
    pub(super) error: NixStorageError,
}
impl NixStorageRetainFailure {
    pub fn into_parts(self: Box<Self>) -> (StorageClaim, NixStoreGuard, NixStorageError) {
        (self.claim, self.guard, self.error)
    }
}
#[must_use = "retain the same actual workflow on uncertainty"]
pub struct NixStorageReclaimFailure {
    pub(super) preparation: NixStoragePreparation,
    pub(super) error: NixStorageError,
}
impl NixStorageReclaimFailure {
    pub fn into_parts(self: Box<Self>) -> (NixStoragePreparation, NixStorageError) {
        (self.preparation, self.error)
    }
}
impl fmt::Debug for NixStorageRetainFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("NixStorageRetainFailure")
            .field(&self.error)
            .finish()
    }
}
impl fmt::Debug for NixStorageReclaimFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("NixStorageReclaimFailure")
            .field(&self.error)
            .finish()
    }
}
impl NixStorageRetainFailure {
    pub fn cause(&self) -> &NixStorageError {
        &self.error
    }
}
impl NixStorageReclaimFailure {
    pub fn cause(&self) -> &NixStorageError {
        &self.error
    }
}
impl fmt::Display for NixStorageRetainFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.error.fmt(f)
    }
}
impl fmt::Display for NixStorageReclaimFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.error.fmt(f)
    }
}
impl Error for NixStorageRetainFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.error)
    }
}
impl Error for NixStorageReclaimFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.error)
    }
}
