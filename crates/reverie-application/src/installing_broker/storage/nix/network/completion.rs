//! Detached completion follows the SAME entry's actual successor. The strict
//! original Created finalizer and all forward Created methods stay unchanged.
use super::*;
use reverie_host::worker_laptop::CreatedLaptop;

impl NetworkStoragePreparation {
    pub(in crate::installing_broker) fn supervisor_completion(
        &self,
        created: &CreatedLaptop,
    ) -> Result<Option<bool>, NetworkStorageError> {
        let ReturnTo::Registered { registry, .. } = &self.destination else {
            return self.created_completed(created).map(Some);
        };
        let entries = registry
            .lock(registry.runtime.stop_deadline())
            .map_err(NixStorageError::from)
            .map_err(NetworkStorageError::Nix)?;
        let index = self
            .started_registered_index(registry, &entries, created)
            .map_err(NixStorageError::from)
            .map_err(NetworkStorageError::Nix)?;
        let entry = &entries[index];
        if let EntryOwner::Laptop(actual) = &entry.owner {
            same_laptop(entry, &self.workflow)?;
            if !created.same_workflow(actual) {
                return Err(NetworkStorageError::Host(LaptopError::Refused(
                    "WORKER_STARTED_HANDOFF_ORIGIN",
                )));
            }
            // Retain SAME entry custody through the Host observation; there
            // is no unlock/relock window in which a successor can publish.
            return self.observe_original_created_receipt(created).map(Some);
        }
        let handoff = entry.started_handoff.as_ref().ok_or_else(changed)?;
        handoff
            .assert_created(&registry.runtime, created)
            .map_err(NetworkStorageError::Host)?;
        self.successor_completion(entry, handoff)
    }
    pub(in crate::installing_broker::storage) fn started_registered_index(
        &self,
        registry: &Arc<StorageRegistry>,
        entries: &[Entry],
        created: &CreatedLaptop,
    ) -> Result<usize, StorageWorkflowError> {
        let ReturnTo::Registered {
            registry: original,
            identity,
            ..
        } = &self.destination
        else {
            return Err(StorageWorkflowError::refused(
                "WORKER_STARTED_HANDOFF_ORIGIN",
            ));
        };
        if !Arc::ptr_eq(original, registry) || !created.same_workflow(&self.workflow) {
            return Err(StorageWorkflowError::refused(
                "WORKER_STARTED_HANDOFF_ORIGIN",
            ));
        }
        let index = entries
            .iter()
            .position(|entry| Arc::ptr_eq(&entry.identity, identity))
            .ok_or_else(|| StorageWorkflowError::refused("WORKER_STORAGE_CLAIM_CHANGED"))?;
        if !entries[index].writer_checked || entries[index].paths != self.paths {
            return Err(StorageWorkflowError::refused(
                "WORKER_STARTED_STORAGE_CHANGED",
            ));
        }
        Ok(index)
    }
    fn successor_completion(
        &self,
        entry: &Entry,
        handoff: &reverie_host::worker_laptop::StartedStorageHandoff,
    ) -> Result<Option<bool>, NetworkStorageError> {
        let runtime = &self.destination.registry().runtime;
        let result = match &entry.owner {
            EntryOwner::Direct(owner) => {
                handoff
                    .assert_storage(runtime, owner)
                    .map_err(NetworkStorageError::Host)?;
                return owner
                    .observe_launch_receipt()
                    .and_then(|receipt| receipt.recheck_is_file(runtime))
                    .map(Some)
                    .map_err(LaptopError::StorageOwner)
                    .map_err(NetworkStorageError::Host);
            }
            EntryOwner::Existing(viewer) => handoff.pending_existing(runtime, viewer),
            EntryOwner::Finalizing(FinalizingStorage::Ready { owner, .. }) => {
                handoff.assert_storage(runtime, owner)
            }
            EntryOwner::Finalizing(FinalizingStorage::Direct { owner, .. }) => {
                match owner.try_lock() {
                    Ok(owner) => handoff.pending_direct_finalizer(runtime, &owner),
                    Err(TryLockError::WouldBlock) => Err(LaptopError::CreatedReceiptPending),
                    Err(TryLockError::Poisoned(_)) => {
                        Err(LaptopError::Refused("WORKER_DIRECT_STORAGE_IN_USE"))
                    }
                }
            }
            _ => return Err(changed()),
        };
        result.map(|()| None).map_err(NetworkStorageError::Host)
    }
}
fn changed() -> NetworkStorageError {
    NetworkStorageError::Nix(NixStorageError::Refused(
        "WORKER_LAPTOP_STORAGE_CLAIM_CHANGED",
    ))
}
