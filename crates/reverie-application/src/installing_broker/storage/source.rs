//! The original acquired resource is fenced before the durable draft claim.
//! These handles retain that SAME owner; they cannot be decoded from paths.
use super::*;
use reverie_core::operations::JournalId;
use std::sync::Weak;
mod stop;
#[cfg(test)]
mod tests;

pub(in crate::installing_broker) struct SourceReference {
    registry: Arc<StorageRegistry>,
    identity: Arc<()>,
    paths: StoragePaths,
}
pub(super) struct SourceRecord {
    owner: Mutex<Option<SourceOwned>>,
    identity: Arc<()>,
    operation: JournalId,
    paths: StoragePaths,
    _office: Arc<super::super::recovered::RecoveredOffice>,
}
enum SourceOwned {
    Direct(Box<LaunchStorage>),
    Stopping(Box<reverie_host::worker_source_stop::OriginalSourceStop>),
    Closed,
}
#[derive(Clone)]
pub(crate) struct RegisteredSource {
    registry: Weak<StorageRegistry>,
    record: Arc<SourceRecord>,
}
pub(in crate::installing_broker) struct SourceAttachment<'a> {
    entries: MutexGuard<'a, Vec<Entry>>,
    source: RegisteredSource,
}
impl StorageClaim {
    pub(in crate::installing_broker) fn original_source_reference(
        &self,
    ) -> Result<SourceReference, StorageWorkflowError> {
        let ClaimState::Registered {
            registry,
            identity,
            paths,
            ..
        } = &self.state
        else {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_SOURCE_EMPLOYEE_LEASE_REQUIRED",
            ));
        };
        if paths.kind() != StorageKind::Employee {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_SOURCE_EMPLOYEE_LEASE_REQUIRED",
            ));
        }
        Ok(SourceReference {
            registry: registry.clone(),
            identity: identity.clone(),
            paths: paths.clone(),
        })
    }
}
impl SourceReference {
    pub(in crate::installing_broker) fn attach(
        &self,
        config: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        operation: JournalId,
        office: Arc<super::super::recovered::RecoveredOffice>,
    ) -> Result<SourceAttachment<'_>, StorageWorkflowError> {
        let mut entries = self.registry.lock(self.registry.runtime.stop_deadline())?;
        let source = self.fence(&mut entries, config, operation, office)?;
        Ok(SourceAttachment { entries, source })
    }
    fn fence(
        &self,
        entries: &mut Vec<Entry>,
        config: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        operation: JournalId,
        office: Arc<super::super::recovered::RecoveredOffice>,
    ) -> Result<RegisteredSource, StorageWorkflowError> {
        let index = entries
            .iter()
            .position(|entry| Arc::ptr_eq(&entry.identity, &self.identity))
            .ok_or_else(|| StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_CHANGED"))?;
        let entry = &entries[index];
        if !entry.writer_checked || entry.paths != self.paths {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_ORIGINAL_SOURCE_CHANGED",
            ));
        }
        let EntryOwner::Direct(owner) = &entry.owner else {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_ORIGINAL_SOURCE_NOT_DIRECT",
            ));
        };
        owner.assert_binding(&self.registry.runtime, config, self.paths.session())?;
        let mut entry = entries.remove(index);
        let EntryOwner::Direct(owner) = entry.owner else {
            unreachable!("checked actual Direct owner")
        };
        let record = Arc::new(SourceRecord {
            owner: Mutex::new(Some(SourceOwned::Direct(owner))),
            identity: self.identity.clone(),
            operation,
            paths: self.paths.clone(),
            _office: office,
        });
        entry.owner = EntryOwner::Source(record.clone());
        entries.insert(index, entry);
        Ok(RegisteredSource {
            registry: Arc::downgrade(&self.registry),
            record,
        })
    }
}
impl RegisteredSource {
    pub(crate) fn assert_claim(
        &self,
        claim: &crate::reservation_gate::RetainedPreparation,
    ) -> Result<(), StorageWorkflowError> {
        if self.record.operation != *claim.operation_id()
            || &self.record.paths != claim.source_paths()
        {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_ORIGINAL_SOURCE_CHANGED",
            ));
        }
        let registry = self
            .registry
            .upgrade()
            .ok_or_else(|| StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_CHANGED"))?;
        let owner =
            self.record.owner.lock().map_err(|_| {
                StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_UNCONFIRMED")
            })?;
        let Some(SourceOwned::Direct(owner)) = owner.as_ref() else {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_ORIGINAL_SOURCE_CONSUMED",
            ));
        };
        owner.assert_binding(
            &registry.runtime,
            claim.source_configuration(),
            claim.source_paths().session(),
        )?;
        Ok(())
    }
    fn restore_unclaimed(&self, entries: &mut [Entry]) -> Result<(), StorageWorkflowError> {
        let entry = entries
            .iter_mut()
            .find(|entry| Arc::ptr_eq(&entry.identity, &self.record.identity))
            .ok_or_else(|| StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_CHANGED"))?;
        if !matches!(&entry.owner, EntryOwner::Source(actual) if Arc::ptr_eq(actual, &self.record))
        {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_ORIGINAL_SOURCE_CHANGED",
            ));
        }
        let mut held =
            self.record.owner.lock().map_err(|_| {
                StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_UNCONFIRMED")
            })?;
        if !matches!(held.as_ref(), Some(SourceOwned::Direct(_))) {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_ORIGINAL_SOURCE_CONSUMED",
            ));
        }
        let Some(SourceOwned::Direct(owner)) = held.take() else {
            unreachable!("checked actual Direct source")
        };
        // No new lease, descriptor close or fallible work after this move.
        entry.owner = EntryOwner::Direct(owner);
        Ok(())
    }
}
impl SourceAttachment<'_> {
    pub(in crate::installing_broker) fn restore_unclaimed(
        mut self,
    ) -> Result<(), StorageWorkflowError> {
        self.source.restore_unclaimed(&mut self.entries)
    }
    pub(in crate::installing_broker) fn join(
        self,
        mut claim: crate::reservation_gate::RetainedPreparation,
    ) -> Result<
        crate::reservation_gate::RetainedPreparation,
        Box<(
            crate::reservation_gate::RetainedPreparation,
            StorageWorkflowError,
        )>,
    > {
        let Self { entries, source } = self;
        if let Err(error) = source.assert_claim(&claim) {
            drop(entries);
            return Err(Box::new((claim, error)));
        }
        claim.attach_original_source(source);
        // The attached owner reaches the retained claim before this actual
        // registry guard is released. There is no post-admission release gap.
        drop(entries);
        Ok(claim)
    }
}
