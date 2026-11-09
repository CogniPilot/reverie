//! The installing service's actual storage registry. A claim retains real
//! resources; labels, returned paths and this handle do not authorize launch.
mod diagnostic;
mod direct_finalization;
mod error;
mod finalization;
pub(in crate::installing_broker) use direct_finalization::{
    DirectStorageFinishFailure, DirectStoragePreparation,
};
mod existing_viewer;
pub(in crate::installing_broker) use existing_viewer::{
    ExistingStorageError, ExistingStoragePreparation, ExistingStorageReturned,
};
mod control_stop;
mod nix;
mod observed;
mod ordinary_stop;
pub(in crate::installing_broker) use control_stop::ControlStorageStop;
mod preparation;
mod recovery_lifetime;
mod replacement_stop;
pub(in crate::installing_broker) use ordinary_stop::OrdinaryStopPreparation;
mod source;
mod started;
mod stopped_ram;
pub use observed::OwnedCreatePreparationError;
pub(crate) use source::RegisteredSource;
pub(super) use source::SourceAttachment;
pub(crate) use stopped_ram::{StoppedRamError, StoppedRamSource};
#[cfg(test)]
pub(in crate::installing_broker) mod tests;
use super::*;
pub use error::{StorageReleaseFailure, StorageWorkflowError};
pub(in crate::installing_broker) use nix::{CreatedStorageFinishFailure, CreatedStorageReturned};
pub use nix::{
    NetworkStorageError, NetworkStoragePreparation, NetworkStorageReclaimFailure,
    NetworkStorageRetainFailure, NetworkStorageReturned, NixStorageError, NixStoragePreparation,
    NixStorageReclaimFailure, NixStorageRetainFailure, NixStorageReturned,
};
pub use replacement_stop::{
    ReplacementStopPreparation, ReplacementStopReclaimFailure, ReplacementStopRetainFailure,
    ReplacementStopReturned,
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
    started_handoff: Option<reverie_host::worker_laptop::StartedStorageHandoff>,
}
enum EntryOwner {
    Direct(Box<LaunchStorage>),
    Finalizing(FinalizingStorage),
    Source(Arc<source::SourceRecord>),
    StoppedRam(Arc<Mutex<stopped_ram::Record>>),
    Nix(reverie_host::worker_nix::NixWorkflow),
    Laptop(reverie_host::worker_laptop::LaptopWorkflow),
    ReplacementStop(Arc<Mutex<reverie_host::worker_source_stop::OrdinaryReplacementStop>>),
    OrdinaryStop(Arc<Mutex<reverie_host::worker_source_stop::OrdinaryLaptopStop>>),
    ControlStop(Arc<Mutex<reverie_host::worker_source_stop::ControlLaptopStop>>),
    Existing(Arc<reverie_host::worker_laptop::ExistingViewer>),
}
enum FinalizingStorage {
    Ready {
        owner: Box<LaunchStorage>,
        brand: Arc<()>,
    },
    Direct {
        owner: Arc<Mutex<reverie_host::worker_laptop::DirectStorageFinalizer>>,
        brand: Arc<()>,
    },
}
struct FinalStorageDecision {
    live: bool,
    brand: Option<Arc<()>>,
}
/// The original claim destination, shared by named resource transitions.
/// These private fields describe where to restore custody, never permission.
enum ClaimDestination {
    Legacy {
        registry: Arc<StorageRegistry>,
    },
    Registered {
        registry: Arc<StorageRegistry>,
        identity: Arc<()>,
        newly_claimed: bool,
    },
}
impl ClaimDestination {
    fn registry(&self) -> &Arc<StorageRegistry> {
        match self {
            Self::Legacy { registry } | Self::Registered { registry, .. } => registry,
        }
    }
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
        self.claim_selected(selected)
    }
    fn claim_selected(
        self: &Arc<Self>,
        selected: reverie_host::worker_storage::StorageSelection,
    ) -> Result<StorageClaim, StorageWorkflowError> {
        let session = selected.paths().session().clone();
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
            .find(|entry| entry.paths.session() == &session)
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
                        started_handoff: None,
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
            started_handoff: None,
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
        require_direct_release(&entries[index].owner)?;
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
                        started_handoff: entry.started_handoff,
                    },
                );
                Err(cause.into())
            }
        }
    }
}
/// Keep this exhaustive: a new retained owner must select its typed refusal
/// before any entry is removed. The caller still holds the SAME registry lock.
fn require_direct_release(owner: &EntryOwner) -> Result<(), StorageWorkflowError> {
    let code = match owner {
        EntryOwner::Direct(_) => return Ok(()),
        EntryOwner::Finalizing(_) => "WORKER_STORAGE_FINALIZATION_HELD",
        EntryOwner::Nix(_) => "WORKER_NIX_STORAGE_RETAINED",
        EntryOwner::Laptop(_) => "WORKER_LAPTOP_STORAGE_RETAINED",
        EntryOwner::Existing(_) => "WORKER_EXISTING_VIEWER_RETAINED",
        EntryOwner::Source(_) => "WORKER_ORIGINAL_SOURCE_RETAINED",
        EntryOwner::StoppedRam(_) => "RAM_STOPPED_SOURCE_RETAINED",
        EntryOwner::ReplacementStop(_) => "WORKER_REPLACEMENT_STOP_RETAINED",
        EntryOwner::OrdinaryStop(_) => "WORKER_ORDINARY_STOP_RETAINED",
        EntryOwner::ControlStop(_) => "WORKER_CONTROL_STOP_RETAINED",
    };
    Err(StorageWorkflowError::refused(code))
}
enum ClaimState {
    Started(Box<started::StartedClaim>),
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
            ClaimState::Started(owner) => &owner.paths,
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
            ClaimState::Started(owner) => Err(Box::new(StorageReleaseFailure {
                claim: StorageClaim {
                    state: ClaimState::Started(owner),
                },
                cause: StorageWorkflowError::refused("WORKER_STARTED_STORAGE_RETAINED"),
            })),
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
