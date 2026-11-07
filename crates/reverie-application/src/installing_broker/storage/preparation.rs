//! Named real resource operations, never a path editor or callback surface.
use super::*;
enum Preparation {
    Storage,
    Binding,
    Cold,
}
impl Preparation {
    fn run(&self, owner: &mut LaunchStorage) -> Result<(), StorageWorkflowError> {
        match self {
            Self::Storage => owner.prepare_storage()?,
            Self::Binding => owner.record_storage_binding()?,
            Self::Cold => owner.prepare_cold_launch_storage()?,
        };
        Ok(())
    }
}
impl StorageClaim {
    /// Canonical pending/fresh-home/storage/lease-inventory prerequisite over
    /// this SAME actual box. It neither clears TMP nor grants a native start.
    pub fn prepare_cold_launch_storage(&mut self) -> Result<(), StorageWorkflowError> {
        self.prepare(Preparation::Cold)
    }
    pub fn prepare_storage(&mut self) -> Result<(), StorageWorkflowError> {
        self.prepare(Preparation::Storage)
    }
    pub fn record_storage_binding(&mut self) -> Result<(), StorageWorkflowError> {
        self.prepare(Preparation::Binding)
    }
    fn prepare(&mut self, operation: Preparation) -> Result<(), StorageWorkflowError> {
        match &mut self.state {
            ClaimState::Legacy { owner, .. } => operation.run(owner),
            ClaimState::Registered {
                registry, identity, ..
            } => {
                let mut entries = registry.lock(registry.runtime.stop_deadline())?;
                let entry = entries
                    .iter_mut()
                    .find(|entry| Arc::ptr_eq(&entry.identity, identity))
                    .ok_or_else(|| StorageWorkflowError::refused("WORKER_STORAGE_CLAIM_CHANGED"))?;
                if !entry.writer_checked {
                    return Err(StorageWorkflowError::refused(
                        "WORKER_STORAGE_CLEANUP_UNCONFIRMED",
                    ));
                }
                let EntryOwner::Direct(owner) = &mut entry.owner else {
                    return Err(StorageWorkflowError::refused("WORKER_NIX_STORAGE_RETAINED"));
                };
                operation.run(owner)
            }
        }
    }
}
