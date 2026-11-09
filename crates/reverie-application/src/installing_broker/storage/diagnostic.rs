//! Only original local custody DATA. No currentness producer, native operation,
//! reconciliation, fd access or resource mutation belongs in this module.
use super::*;
use reverie_contracts::{
    storage_identity::Metadata,
    worker_storage_status::{OwnerKind, OwnerObservation, StorageOwnerRow},
};
use std::sync::TryLockError;
pub(super) const MAX_DIAGNOSTIC_ENTRIES: usize = 256;
impl StorageRegistry {
    pub(in crate::installing_broker) fn storage_status(
        &self,
        company: &Metadata,
    ) -> Result<Vec<StorageOwnerRow>, StorageWorkflowError> {
        let entries = self
            .entries
            .try_lock()
            .map_err(|_| StorageWorkflowError::refused("STORAGE_STATUS_LOCK_UNAVAILABLE"))?;
        if entries.len() > MAX_DIAGNOSTIC_ENTRIES {
            return Err(StorageWorkflowError::refused("STORAGE_STATUS_BOUND"));
        }
        // Native methods below only try_lock and read local fields. Keeping
        // this registry guard retains exact entry/variant identity throughout;
        // no waiting, producer or inverse-lock acquisition is invoked here.
        Ok(entries
            .iter()
            .map(|entry| entry.diagnostic_row(company))
            .collect())
    }
}
impl Entry {
    pub(super) fn diagnostic_row(&self, company: &Metadata) -> StorageOwnerRow {
        let (owner_kind, observation) = self.owner.diagnostic();
        let current_session_generation = self.paths.employee().and_then(|employee| {
            // Missing/invalid generation is explicitly unknown DATA here;
            // it must never be replaced with a default or owner's epoch.
            company
                .current_employee(employee, self.paths.session(), self.paths.owner())
                .ok()
                .flatten()
                .map(|row| row.generation().decimal().to_owned())
        });
        StorageOwnerRow {
            session_id: self.paths.session().as_str().to_owned(),
            current_session_generation,
            writer_checked: self.writer_checked,
            owner_kind,
            observation,
        }
    }
}
fn locked<T>(owner: &Mutex<T>, inspect: impl FnOnce(&T) -> OwnerObservation) -> OwnerObservation {
    match owner.try_lock() {
        Ok(guard) => inspect(&guard),
        Err(TryLockError::WouldBlock) => OwnerObservation::Busy,
        Err(TryLockError::Poisoned(_)) => OwnerObservation::Poisoned,
    }
}
impl EntryOwner {
    fn diagnostic(&self) -> (OwnerKind, OwnerObservation) {
        match self {
            Self::Direct(owner) => (OwnerKind::Direct, owner.storage_owner_status()),
            Self::Finalizing(FinalizingStorage::Ready { owner, .. }) => {
                (OwnerKind::FinalizingReady, owner.storage_owner_status())
            }
            Self::Finalizing(FinalizingStorage::Direct { owner, .. }) => (
                OwnerKind::FinalizingDirect,
                locked(owner, |owner| owner.storage_owner_status()),
            ),
            Self::Source(owner) => (OwnerKind::Source, owner.storage_owner_status()),
            Self::StoppedRam(owner) => (
                OwnerKind::StoppedRam,
                locked(owner, |owner| owner.storage_owner_status()),
            ),
            Self::Nix(owner) => (OwnerKind::Nix, owner.storage_owner_status()),
            Self::Laptop(owner) => (OwnerKind::Laptop, owner.storage_owner_status()),
            Self::ReplacementStop(owner) => (
                OwnerKind::ReplacementStop,
                locked(owner, |owner| owner.storage_owner_status()),
            ),
            Self::OrdinaryStop(owner) => (
                OwnerKind::OrdinaryStop,
                locked(owner, |owner| owner.storage_owner_status()),
            ),
            Self::ControlStop(owner) => (
                OwnerKind::ControlStop,
                locked(owner, |owner| owner.storage_owner_status()),
            ),
            Self::Existing(owner) => (OwnerKind::ExistingViewer, owner.storage_owner_status()),
        }
    }
}
