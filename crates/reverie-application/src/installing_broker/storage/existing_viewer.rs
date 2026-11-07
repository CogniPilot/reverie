//! Same-Box classified reuse transfer. Neither native viewer cleanup nor this
//! atomic restoration acknowledges a stopped laptop or storage/global release.
use super::*;
use reverie_contracts::worker_launch::WorkerRequest;
use reverie_host::{
    worker_laptop::{ExistingViewer, ExistingViewerStart, LaptopError},
    worker_launch::{ExistingLaptopInspection, ObservedCreatePlan},
    worker_storage::LaunchReceiptObservation,
};
mod error;
pub(in crate::installing_broker) use error::{
    ExistingStorageError, ExistingStorageReclaimFailure, ExistingStorageRetainFailure,
};

enum Destination {
    Legacy {
        registry: Arc<StorageRegistry>,
    },
    Registered {
        registry: Arc<StorageRegistry>,
        identity: Arc<()>,
        newly_claimed: bool,
    },
}
impl Destination {
    fn registry(&self) -> &Arc<StorageRegistry> {
        match self {
            Self::Legacy { registry } | Self::Registered { registry, .. } => registry,
        }
    }
}
struct Inputs {
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    inspected: ExistingLaptopInspection,
    receipt: LaunchReceiptObservation,
}
#[must_use = "retain the SAME native owner, original registry and actual J scope"]
pub(in crate::installing_broker) struct ExistingStoragePreparation {
    destination: Destination,
    viewer: Arc<ExistingViewer>,
}
impl ExistingStoragePreparation {
    pub(in crate::installing_broker) fn start(
        &self,
        end: Instant,
    ) -> Result<ExistingViewerStart, ExistingStorageError> {
        self.check()?;
        Ok(self
            .destination
            .registry()
            .runtime
            .start_existing_viewer(&self.viewer, end)?)
    }
    pub(in crate::installing_broker) fn close(
        &self,
        end: Instant,
    ) -> Result<(), ExistingStorageError> {
        self.check()?;
        Ok(self
            .destination
            .registry()
            .runtime
            .close_existing_viewer(&self.viewer, end)?)
    }
    fn check(&self) -> Result<(), ExistingStorageError> {
        if let Destination::Registered {
            registry, identity, ..
        } = &self.destination
        {
            let entries = registry.lock(registry.runtime.stop_deadline())?;
            let index = selected(&entries, identity)?;
            same(&entries[index], &self.viewer)?;
        }
        Ok(())
    }
    pub(in crate::installing_broker) fn reclaim(
        self,
    ) -> Result<ExistingStorageReturned, Box<ExistingStorageReclaimFailure>> {
        let result = match &self.destination {
            Destination::Legacy { registry } => reclaim_legacy(registry, &self.viewer),
            Destination::Registered {
                registry,
                identity,
                newly_claimed,
            } => reclaim_registered(registry, identity, &self.viewer, *newly_claimed),
        };
        result.map_err(|error| {
            Box::new(ExistingStorageReclaimFailure {
                preparation: self,
                error,
            })
        })
    }
}
#[must_use = "the actual restored claim remains held; this is not release credit"]
pub(in crate::installing_broker) struct ExistingStorageReturned {
    claim: StorageClaim,
    inputs: Inputs,
    outcome: Option<Arc<LaptopError>>,
}
impl ExistingStorageReturned {
    pub(in crate::installing_broker) fn into_parts(
        self,
    ) -> (
        StorageClaim,
        ObservedCreatePlan,
        WorkerRequest,
        ExistingLaptopInspection,
        LaunchReceiptObservation,
        Option<Arc<LaptopError>>,
    ) {
        let inputs = self.inputs;
        (
            self.claim,
            inputs.plan,
            inputs.request,
            inputs.inspected,
            inputs.receipt,
            self.outcome,
        )
    }
}
impl StorageClaim {
    /// Pure resource handoff only. The actual classified App continuation must
    /// release its lifecycle/allocation scope before starting the native job.
    pub(in crate::installing_broker) fn retain_existing_relay(
        self,
        plan: ObservedCreatePlan,
        request: WorkerRequest,
        inspected: ExistingLaptopInspection,
        receipt: LaunchReceiptObservation,
    ) -> Result<ExistingStoragePreparation, Box<ExistingStorageRetainFailure>> {
        let inputs = Inputs {
            plan,
            request,
            inspected,
            receipt,
        };
        match self.state {
            ClaimState::Legacy { registry, owner } => {
                match retain_native(&registry, owner, inputs) {
                    Ok(viewer) => Ok(ExistingStoragePreparation {
                        destination: Destination::Legacy { registry },
                        viewer,
                    }),
                    Err((owner, inputs, error)) => Err(Box::new(ExistingStorageRetainFailure {
                        claim: StorageClaim {
                            state: ClaimState::Legacy { registry, owner },
                        },
                        inputs,
                        error,
                    })),
                }
            }
            ClaimState::Registered {
                registry,
                identity,
                paths,
                newly_claimed,
            } => match registry.retain_existing(&identity, inputs) {
                Ok(viewer) => Ok(ExistingStoragePreparation {
                    destination: Destination::Registered {
                        registry,
                        identity,
                        newly_claimed,
                    },
                    viewer,
                }),
                Err((inputs, error)) => Err(Box::new(ExistingStorageRetainFailure {
                    claim: StorageClaim {
                        state: ClaimState::Registered {
                            registry,
                            identity,
                            paths,
                            newly_claimed,
                        },
                    },
                    inputs,
                    error,
                })),
            },
        }
    }
}
fn retain_native(
    registry: &StorageRegistry,
    owner: Box<LaunchStorage>,
    inputs: Inputs,
) -> Result<Arc<ExistingViewer>, (Box<LaunchStorage>, Inputs, ExistingStorageError)> {
    match registry.runtime.retain_existing_relay(
        owner,
        inputs.plan,
        inputs.request,
        inputs.inspected,
        inputs.receipt,
    ) {
        Ok(viewer) => Ok(Arc::new(viewer)),
        Err(failure) => {
            let (owner, plan, request, inspected, receipt, error) = failure.into_parts();
            Err((
                owner,
                Inputs {
                    plan,
                    request,
                    inspected,
                    receipt,
                },
                error.into(),
            ))
        }
    }
}
impl StorageRegistry {
    fn retain_existing(
        &self,
        identity: &Arc<()>,
        inputs: Inputs,
    ) -> Result<Arc<ExistingViewer>, (Inputs, ExistingStorageError)> {
        let mut entries = match self.lock(self.runtime.stop_deadline()) {
            Ok(entries) => entries,
            Err(error) => return Err((inputs, error.into())),
        };
        let index = match selected(&entries, identity) {
            Ok(index) => index,
            Err(error) => return Err((inputs, error)),
        };
        if !entries[index].writer_checked || !matches!(entries[index].owner, EntryOwner::Direct(_))
        {
            return Err((
                inputs,
                ExistingStorageError::Refused("WORKER_EXISTING_STORAGE_RETAINED"),
            ));
        }
        let mut entry = entries.remove(index);
        let EntryOwner::Direct(owner) = entry.owner else {
            unreachable!("checked same Direct box")
        };
        match retain_native(self, owner, inputs) {
            Ok(viewer) => {
                entry.owner = EntryOwner::Existing(viewer.clone());
                entries.insert(index, entry);
                Ok(viewer)
            }
            Err((owner, inputs, error)) => {
                entry.owner = EntryOwner::Direct(owner);
                entries.insert(index, entry);
                Err((inputs, error))
            }
        }
    }
}
fn selected(entries: &[Entry], identity: &Arc<()>) -> Result<usize, ExistingStorageError> {
    entries
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        .ok_or(ExistingStorageError::Refused(
            "WORKER_EXISTING_STORAGE_CLAIM_CHANGED",
        ))
}
fn same(entry: &Entry, actual: &Arc<ExistingViewer>) -> Result<(), ExistingStorageError> {
    if matches!(&entry.owner, EntryOwner::Existing(viewer) if Arc::ptr_eq(viewer, actual)) {
        Ok(())
    } else {
        Err(ExistingStorageError::Refused(
            "WORKER_EXISTING_STORAGE_CLAIM_CHANGED",
        ))
    }
}
fn reclaim_registered(
    registry: &Arc<StorageRegistry>,
    identity: &Arc<()>,
    viewer: &Arc<ExistingViewer>,
    newly_claimed: bool,
) -> Result<ExistingStorageReturned, ExistingStorageError> {
    let mut entries = registry.lock(registry.runtime.stop_deadline())?;
    let index = selected(&entries, identity)?;
    same(&entries[index], viewer)?;
    // Clone before borrowing the entry. All fallible checks and both actual
    // Host guards precede take; Direct replacement below is infallible.
    let retained = viewer.clone();
    let returned = registry.runtime.reclaim_existing_relay(&retained)?;
    let (owner, plan, request, inspected, receipt, outcome) = returned.into_parts();
    entries[index].owner = EntryOwner::Direct(owner);
    Ok(ExistingStorageReturned {
        claim: registry.handle(&entries[index], newly_claimed),
        inputs: Inputs {
            plan,
            request,
            inspected,
            receipt,
        },
        outcome,
    })
}
fn reclaim_legacy(
    registry: &Arc<StorageRegistry>,
    viewer: &Arc<ExistingViewer>,
) -> Result<ExistingStorageReturned, ExistingStorageError> {
    let returned = registry.runtime.reclaim_existing_relay(viewer)?;
    let (owner, plan, request, inspected, receipt, outcome) = returned.into_parts();
    Ok(ExistingStorageReturned {
        claim: StorageClaim {
            state: ClaimState::Legacy {
                registry: registry.clone(),
                owner,
            },
        },
        inputs: Inputs {
            plan,
            request,
            inspected,
            receipt,
        },
        outcome,
    })
}
