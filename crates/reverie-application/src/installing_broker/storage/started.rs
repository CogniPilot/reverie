//! Later-J borrowing keeps the original Created resource in its SAME Host and
//! App records. Only genuine consuming purposes may move it out.
use super::*;
use crate::installing_broker::launch::StartedLaptop;
use reverie_host::{worker_laptop::StartedStorageBorrow, worker_reports::WorkerLaunchConnection};

pub(super) struct StartedClaim {
    pub(super) destination: ClaimDestination,
    pub(super) paths: StoragePaths,
    pub(super) owner: Arc<StartedLaptop>,
    pub(super) connection: Arc<WorkerLaunchConnection>,
}
impl StartedClaim {
    pub(super) fn borrow(&self) -> Result<StartedStorageBorrow<'_>, StorageWorkflowError> {
        let registry = self.destination.registry();
        if let ClaimDestination::Registered { identity, .. } = &self.destination {
            let entries = registry.lock(registry.runtime.stop_deadline())?;
            let entry = entries
                .iter()
                .find(|entry| Arc::ptr_eq(&entry.identity, identity))
                .ok_or_else(|| StorageWorkflowError::refused("WORKER_STORAGE_CLAIM_CHANGED"))?;
            if !entry.writer_checked
                || entry.paths != self.paths
                || !matches!(&entry.owner, EntryOwner::Laptop(actual) if self.owner.created.same_workflow(actual))
            {
                return Err(StorageWorkflowError::refused(
                    "WORKER_STARTED_STORAGE_CHANGED",
                ));
            }
        }
        Ok(registry
            .runtime
            .borrow_started_laptop_storage(&self.owner.created, &self.connection)?)
    }
}
impl InstallingBroker {
    pub(in crate::installing_broker) fn claim_launch_storage(
        &self,
        connection: &Arc<WorkerLaunchConnection>,
    ) -> Result<StorageClaim, StorageWorkflowError> {
        let session = connection.request().session();
        let snapshot = self.configuration()?;
        let lifecycle = self.installed.lifecycle()?;
        let started = lifecycle.guard.iter().find_map(|entry| {
            if &entry.session != session {
                return None;
            }
            match &entry.owner {
                LaptopOwner::Started(owner) => Some(owner.clone()),
                _ => None,
            }
        });
        let Some(started) = started else {
            drop(lifecycle);
            return self.storage.claim(snapshot.configuration(), session);
        };
        let selected = self
            .storage
            .runtime
            .resolve_storage(snapshot.configuration(), session)?;
        let paths = selected.paths().clone();
        if started.network.paths() != &paths {
            return Err(StorageWorkflowError::refused(
                "WORKER_EMPLOYEE_BINDING_CHANGED",
            ));
        }
        let destination = if paths.kind() == StorageKind::Employee {
            let entries = self.storage.lock(self.storage.runtime.stop_deadline())?;
            let entry = entries
                .iter()
                .find(|entry| entry.paths.session() == session)
                .ok_or_else(|| StorageWorkflowError::refused("WORKER_STORAGE_CLAIM_CHANGED"))?;
            if matches!(entry.owner, EntryOwner::Direct(_)) {
                drop(entries);
                drop(lifecycle);
                return self.storage.claim_selected(selected);
            }
            if !entry.writer_checked
                || entry.paths != paths
                || !matches!(&entry.owner, EntryOwner::Laptop(actual) if started.created.same_workflow(actual))
            {
                return Err(StorageWorkflowError::refused(
                    "WORKER_STARTED_STORAGE_CHANGED",
                ));
            }
            ClaimDestination::Registered {
                registry: self.storage.clone(),
                identity: entry.identity.clone(),
                newly_claimed: false,
            }
        } else {
            ClaimDestination::Legacy {
                registry: self.storage.clone(),
            }
        };
        let owner = StartedClaim {
            destination,
            paths,
            owner: started,
            connection: connection.clone(),
        };
        let borrowed = owner.borrow()?;
        borrowed.assert_binding(snapshot.configuration(), session)?;
        borrowed.check_storage_writers_for_worker()?;
        drop(borrowed);
        Ok(StorageClaim {
            state: ClaimState::Started(Box::new(owner)),
        })
    }
}
