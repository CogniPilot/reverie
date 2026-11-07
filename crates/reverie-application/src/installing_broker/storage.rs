//! The installing service's actual storage registry. A claim retains real
//! resources; labels, returned paths and this handle do not authorize launch.
mod error;
mod existing_viewer;
pub(in crate::installing_broker) use existing_viewer::{
    ExistingStorageError, ExistingStoragePreparation, ExistingStorageReclaimFailure,
    ExistingStorageRetainFailure, ExistingStorageReturned,
};
mod nix;
mod observed;
mod preparation;
mod recovery_lifetime;
mod source;
pub use observed::OwnedCreatePreparationError;
pub(crate) use source::RegisteredSource;
pub(super) use source::SourceAttachment;
#[cfg(test)]
pub(in crate::installing_broker) mod tests;
use super::*;
pub use error::{StorageReleaseFailure, StorageWorkflowError};
pub use nix::{
    NetworkStorageError, NetworkStoragePreparation, NetworkStorageReclaimFailure,
    NetworkStorageRetainFailure, NetworkStorageReturned, NixStorageError, NixStoragePreparation,
    NixStorageReclaimFailure, NixStorageRetainFailure, NixStorageReturned,
};
use reverie_host::{
    worker_runtime::WorkerRuntime,
    worker_storage::{LaunchStorage, StorageOwnerError},
};
use reverie_store::storage_identity::{StorageKind, StoragePaths};
use std::{
    sync::TryLockError,
    time::{Duration, Instant},
};

struct Entry {
    identity: Arc<()>,
    paths: StoragePaths,
    owner: EntryOwner,
    writer_checked: bool,
}
enum EntryOwner {
    Direct(Box<LaunchStorage>),
    Source(Arc<source::SourceRecord>),
    Nix(reverie_host::worker_nix::NixWorkflow),
    Laptop(reverie_host::worker_laptop::LaptopWorkflow),
    Existing(Arc<reverie_host::worker_laptop::ExistingViewer>),
}
pub(super) struct StorageRegistry {
    pub(super) runtime: WorkerRuntime,
    entries: Mutex<Vec<Entry>>,
}
impl StorageRegistry {
    pub(super) fn new(runtime: WorkerRuntime) -> Self {
        Self {
            runtime,
            entries: Mutex::new(Vec::new()),
        }
    }
    fn lock(
        &self,
        deadline: Option<Instant>,
    ) -> Result<MutexGuard<'_, Vec<Entry>>, StorageWorkflowError> {
        let Some(deadline) = deadline else {
            #[cfg(test)]
            tests::before_blocking_lock();
            return self
                .entries
                .lock()
                .map_err(|_| StorageWorkflowError::refused("STORAGE_LOCK_UNAVAILABLE"));
        };
        loop {
            match self.entries.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(_)) => {
                    return Err(StorageWorkflowError::refused("STORAGE_LOCK_UNAVAILABLE"));
                }
                Err(TryLockError::WouldBlock) => {}
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(StorageWorkflowError::refused("STORAGE_LOCK_UNAVAILABLE"));
            }
            std::thread::sleep(deadline.duration_since(now).min(Duration::from_millis(1)));
        }
    }
    pub(super) fn claim(
        self: &Arc<Self>,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<StorageClaim, StorageWorkflowError> {
        // Preserve source order and the real no-lease legacy branch: resolve
        // BEFORE the registry lock, and never census/register legacy storage.
        let selected = self.runtime.resolve_storage(source, session)?;
        if selected.paths().kind() != StorageKind::Employee {
            return Ok(StorageClaim {
                state: ClaimState::Legacy {
                    registry: self.clone(),
                    owner: Box::new(selected.into_legacy()?),
                },
            });
        }
        let mut entries = self.lock(None)?;
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.paths.session() == session)
        {
            if matches!(entry.owner, EntryOwner::Source(_)) {
                return Err(StorageWorkflowError::refused(
                    "WORKER_ORIGINAL_SOURCE_RETAINED",
                ));
            }
            if !entry.writer_checked || !matches!(entry.owner, EntryOwner::Direct(_)) {
                return Err(StorageWorkflowError::refused(
                    "WORKER_STORAGE_CLEANUP_UNCONFIRMED",
                ));
            }
            if &entry.paths != selected.paths() {
                return Err(StorageWorkflowError::refused(
                    "WORKER_EMPLOYEE_BINDING_CHANGED",
                ));
            }
            self.runtime
                .check_selected_storage_writers(&selected, None)?;
            return Ok(self.handle(entry, false));
        }
        if entries
            .iter()
            .any(|entry| entry.paths.key() == selected.paths().key())
        {
            return Err(StorageWorkflowError::refused(
                "WORKER_PREVIOUS_EMPLOYEE_STORAGE_BUSY",
            ));
        }
        let owner = selected
            .acquire()
            .map_err(|failure| StorageWorkflowError::from(failure.into_parts().1))?;
        if let Err(primary) = self.runtime.check_storage_writers(&owner, None) {
            let end = self
                .runtime
                .stop_deadline()
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(20));
            return match owner.close(end) {
                Ok(()) => Err(primary.into()),
                Err(failure) => {
                    let (owner, cleanup) = failure.into_parts();
                    entries.push(Entry {
                        identity: Arc::new(()),
                        paths: owner.paths().clone(),
                        owner: EntryOwner::Direct(Box::new(owner)),
                        writer_checked: false,
                    });
                    Err(StorageWorkflowError::with_cleanup(primary, cleanup))
                }
            };
        }
        let entry = Entry {
            identity: Arc::new(()),
            paths: owner.paths().clone(),
            owner: EntryOwner::Direct(Box::new(owner)),
            writer_checked: true,
        };
        let result = self.handle(&entry, true);
        entries.push(entry);
        Ok(result)
    }
    fn handle(self: &Arc<Self>, entry: &Entry, newly_claimed: bool) -> StorageClaim {
        StorageClaim {
            state: ClaimState::Registered {
                registry: self.clone(),
                identity: entry.identity.clone(),
                paths: entry.paths.clone(),
                newly_claimed,
            },
        }
    }
    fn release(&self, identity: &Arc<()>, deadline: Instant) -> Result<(), StorageWorkflowError> {
        let end = self
            .runtime
            .stop_deadline()
            .map_or(deadline, |stop| stop.min(deadline));
        let mut entries = self.lock(self.runtime.stop_deadline())?;
        let Some(index) = entries
            .iter()
            .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        else {
            return Ok(());
        };
        if matches!(entries[index].owner, EntryOwner::Nix(_)) {
            return Err(StorageWorkflowError::refused("WORKER_NIX_STORAGE_RETAINED"));
        }
        if matches!(entries[index].owner, EntryOwner::Laptop(_)) {
            return Err(StorageWorkflowError::refused(
                "WORKER_LAPTOP_STORAGE_RETAINED",
            ));
        }
        if matches!(entries[index].owner, EntryOwner::Existing(_)) {
            return Err(StorageWorkflowError::refused(
                "WORKER_EXISTING_VIEWER_RETAINED",
            ));
        }
        if matches!(entries[index].owner, EntryOwner::Source(_)) {
            return Err(StorageWorkflowError::refused(
                "WORKER_ORIGINAL_SOURCE_RETAINED",
            ));
        }
        let entry = entries.remove(index);
        let EntryOwner::Direct(owner) = entry.owner else {
            unreachable!("checked direct owner")
        };
        match owner.close(end) {
            Ok(()) => Ok(()),
            Err(failure) => {
                let (owner, cause) = failure.into_parts();
                entries.insert(
                    index,
                    Entry {
                        owner: EntryOwner::Direct(Box::new(owner)),
                        paths: entry.paths,
                        writer_checked: false,
                        identity: entry.identity,
                    },
                );
                Err(cause.into())
            }
        }
    }
}
enum ClaimState {
    Legacy {
        registry: Arc<StorageRegistry>,
        owner: Box<LaunchStorage>,
    },
    Registered {
        registry: Arc<StorageRegistry>,
        identity: Arc<()>,
        paths: StoragePaths,
        newly_claimed: bool,
    },
}
/// Nonserializable result of the real service operation. Drop does not remove
/// employee registry resources, acknowledge release or stop a laptop.
pub struct StorageClaim {
    state: ClaimState,
}
impl StorageClaim {
    pub fn paths(&self) -> &StoragePaths {
        match &self.state {
            ClaimState::Legacy { owner, .. } => owner.paths(),
            ClaimState::Registered { paths, .. } => paths,
        }
    }
    pub fn newly_claimed(&self) -> bool {
        matches!(
            &self.state,
            ClaimState::Registered {
                newly_claimed: true,
                ..
            }
        )
    }
    /// Consumes an exact actual claim handle, never a request-selected SID.
    /// This is resource settlement, not stopped-container/capacity proof. The
    /// caller must settle every actual subprocess producer before interpreting
    /// local descriptor consumption as a global writer release. Only the first
    /// captured stop budget bounds the registry mutex wait, as in the source;
    /// filesystem calls do not have a hard kernel/disk latency guarantee.
    pub fn release(self, deadline: Instant) -> Result<(), Box<StorageReleaseFailure>> {
        match self.state {
            ClaimState::Legacy { registry, owner } => owner.close(deadline).map_err(|failure| {
                let (owner, cause) = failure.into_parts();
                Box::new(StorageReleaseFailure {
                    claim: StorageClaim {
                        state: ClaimState::Legacy {
                            registry,
                            owner: Box::new(owner),
                        },
                    },
                    cause: cause.into(),
                })
            }),
            ClaimState::Registered {
                registry,
                identity,
                paths,
                newly_claimed,
            } => match registry.release(&identity, deadline) {
                Ok(()) => Ok(()),
                Err(cause) => Err(Box::new(StorageReleaseFailure {
                    claim: StorageClaim {
                        state: ClaimState::Registered {
                            registry,
                            identity,
                            paths,
                            newly_claimed,
                        },
                    },
                    cause,
                })),
            },
        }
    }
}
