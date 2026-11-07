//! One physical finalization transaction for the actual registered Box. A
//! native read is DATA; the whole outer handler proves its writer cleanup.
use super::*;

pub(super) fn finish_registered(
    registry: &StorageRegistry,
    identity: &Arc<()>,
    decision: &FinalStorageDecision,
    end: Instant,
) -> Result<bool, StorageWorkflowError> {
    let mut entries = registry.lock(registry.runtime.stop_deadline())?;
    let index = entries
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        .ok_or_else(|| StorageWorkflowError::refused("WORKER_EXISTING_STORAGE_CLAIM_CHANGED"))?;
    let EntryOwner::Finalizing(FinalizingStorage::Ready { brand, .. }) = &entries[index].owner
    else {
        return Err(StorageWorkflowError::refused(
            "WORKER_FINAL_STORAGE_CHANGED",
        ));
    };
    if !decision
        .brand
        .as_ref()
        .is_some_and(|expected| Arc::ptr_eq(expected, brand))
    {
        return Err(StorageWorkflowError::refused("WORKER_FINAL_STORAGE_BRAND"));
    }
    let mut entry = entries.remove(index);
    let EntryOwner::Finalizing(FinalizingStorage::Ready { owner, brand }) = entry.owner else {
        unreachable!("same checked phase");
    };
    if decision.live {
        entry.owner = EntryOwner::Direct(owner);
        entries.insert(index, entry);
        return Ok(true);
    }
    match owner.close(end) {
        Ok(()) => Ok(false),
        Err(failure) => {
            let (owner, cause) = failure.into_parts();
            entry.owner = EntryOwner::Finalizing(FinalizingStorage::Ready {
                owner: Box::new(owner),
                brand,
            });
            entry.writer_checked = false;
            entries.insert(index, entry);
            Err(cause.into())
        }
    }
}
