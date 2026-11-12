//! Readonly identity of existing entries. Original Boxes, leases and workflows
//! remain in the same registry; no stop, borrow or release authority is minted.
use super::*;
use reverie_contracts::{
    storage_identity::Metadata,
    worker_storage_status::{OwnerObservation, StorageOwnerRow},
};

struct ObservedEntry {
    identity: Arc<()>,
    paths: StoragePaths,
    data: StorageOwnerRow,
}
pub(in crate::installing_broker) struct StorageFleetSnapshot {
    registry: Arc<StorageRegistry>,
    entries: Vec<ObservedEntry>,
}
impl StorageRegistry {
    pub(in crate::installing_broker) fn capture_fleet_preview(
        self: &Arc<Self>,
        company: &Metadata,
    ) -> Result<StorageFleetSnapshot, StorageWorkflowError> {
        let entries = self.entries.try_lock().map_err(|_| unavailable())?;
        if entries.len() > diagnostic::MAX_DIAGNOSTIC_ENTRIES {
            return Err(unavailable());
        }
        let entries = entries
            .iter()
            .map(|entry| {
                let data = checked_data(entry, company)?;
                Ok(ObservedEntry {
                    identity: Arc::clone(&entry.identity),
                    paths: entry.paths.clone(),
                    data,
                })
            })
            .collect::<Result<Vec<_>, StorageWorkflowError>>()?;
        Ok(StorageFleetSnapshot {
            registry: Arc::clone(self),
            entries,
        })
    }
}
impl StorageFleetSnapshot {
    pub(in crate::installing_broker) fn paths_for_session(
        &self,
        session: &ProfileSessionId,
    ) -> Option<&StoragePaths> {
        self.entries
            .iter()
            .find(|entry| entry.paths.session() == session)
            .map(|entry| &entry.paths)
    }
    pub(in crate::installing_broker) fn rows(&self) -> Vec<StorageOwnerRow> {
        self.entries
            .iter()
            .map(|entry| entry.data.clone())
            .collect()
    }
    pub(in crate::installing_broker) fn assert_current(
        &self,
        registry: &Arc<StorageRegistry>,
        company: &Metadata,
    ) -> Result<(), StorageWorkflowError> {
        if !Arc::ptr_eq(&self.registry, registry) {
            return Err(unavailable());
        }
        let current = registry.entries.try_lock().map_err(|_| unavailable())?;
        if current.len() != self.entries.len() {
            return Err(unavailable());
        }
        for observed in &self.entries {
            let entry = current
                .iter()
                .find(|entry| Arc::ptr_eq(&entry.identity, &observed.identity))
                .ok_or_else(unavailable)?;
            if entry.paths != observed.paths || checked_data(entry, company)? != observed.data {
                return Err(unavailable());
            }
        }
        Ok(())
    }
}
fn checked_data(
    entry: &Entry,
    company: &Metadata,
) -> Result<StorageOwnerRow, StorageWorkflowError> {
    if !entry.writer_checked {
        return Err(StorageWorkflowError::refused(
            "WORKER_STORAGE_CLEANUP_UNCONFIRMED",
        ));
    }
    let data = entry.diagnostic_row(company);
    if matches!(data.observation, OwnerObservation::Poisoned) {
        return Err(unavailable());
    }
    Ok(data)
}
fn unavailable() -> StorageWorkflowError {
    StorageWorkflowError::refused("FLEET_PREVIEW_STORAGE_UNAVAILABLE")
}
