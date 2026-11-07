//! Same-Box classified reuse transfer. Neither native viewer cleanup nor this
//! atomic restoration acknowledges a stopped laptop or storage/global release.
use super::ClaimDestination as Destination;
use super::*;
use reverie_contracts::worker_launch::WorkerRequest;
use reverie_host::{
    worker_laptop::{ExistingViewer, ExistingViewerStart, LaptopError},
    worker_launch::{ExistingLaptopInspection, ObservedCreatePlan},
    worker_storage::LaunchReceiptObservation,
};
mod error;
mod finalization;
pub(in crate::installing_broker) use error::{
    ExistingStorageError, ExistingStorageReclaimFailure, ExistingStorageRetainFailure,
};

struct Inputs {
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    inspected: ExistingLaptopInspection,
    receipt: LaunchReceiptObservation,
}
struct NativeRetainFailure {
    owner: Box<LaunchStorage>,
    inputs: Inputs,
    error: ExistingStorageError,
}
struct RegistryRetainFailure {
    inputs: Inputs,
    error: ExistingStorageError,
}
#[must_use = "retain the SAME native owner, original registry and actual J scope"]
pub(in crate::installing_broker) struct ExistingStoragePreparation {
    destination: Destination,
    viewer: Arc<ExistingViewer>,
}
impl ExistingStoragePreparation {
    pub(in crate::installing_broker) fn failure(
        &self,
    ) -> Result<Option<Arc<LaptopError>>, LaptopError> {
        self.viewer.failure()
    }
    pub(in crate::installing_broker) fn start(
        &self,
        connection: &reverie_host::worker_reports::WorkerLaunchConnection,
        end: Instant,
    ) -> Result<ExistingViewerStart, ExistingStorageError> {
        self.check()?;
        Ok(self
            .destination
            .registry()
            .runtime
            .start_existing_viewer_for_connection(&self.viewer, connection, end)?)
    }
    pub(in crate::installing_broker) fn start_for_worker(
        &self,
        connection: &reverie_host::worker_reports::WorkerLaunchConnection,
    ) -> Result<ExistingViewerStart, ExistingStorageError> {
        self.check()?;
        Ok(self
            .destination
            .registry()
            .runtime
            .start_existing_viewer_for_worker(&self.viewer, connection)?)
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
            Destination::Legacy { registry } => reclaim_legacy(registry, &self.viewer, None),
            Destination::Registered {
                registry,
                identity,
                newly_claimed,
            } => reclaim_registered(registry, identity, &self.viewer, *newly_claimed, None),
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
    finalization: Option<FinalStorageDecision>,
}
#[cfg(test)]
impl ExistingStorageReturned {
    /// Actual synthetic-fixture teardown only; no production release token.
    pub(in crate::installing_broker) fn fixture_claim(self) -> StorageClaim {
        self.claim
    }
}
impl std::fmt::Debug for ExistingStorageReturned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExistingStorageReturned")
            .field("storage", self.claim.paths())
            .field("name", &self.inputs.plan.arguments().name())
            .field("session", self.inputs.request.session())
            .field("running_readback", &self.inputs.inspected.data().running())
            .field("receipt_readback", &self.inputs.receipt.exists())
            .field("native_outcome", &self.outcome)
            .finish_non_exhaustive()
    }
}
impl ExistingStorageReturned {
    pub(in crate::installing_broker) fn failure(&self) -> Option<&LaptopError> {
        self.outcome.as_deref()
    }
}
impl StorageClaim {
    /// Pure resource handoff only. The actual classified App continuation must
    /// release its lifecycle/allocation scope before starting the native job.
    pub(in crate::installing_broker) fn retain_existing_relay_for_connection(
        self,
        plan: ObservedCreatePlan,
        inspected: ExistingLaptopInspection,
        receipt: LaunchReceiptObservation,
        connection: &reverie_host::worker_reports::WorkerLaunchConnection,
    ) -> Result<ExistingStoragePreparation, Box<ExistingStorageRetainFailure>> {
        let inputs = Inputs {
            plan,
            request: connection.request().clone(),
            inspected,
            receipt,
        };
        match self.state {
            ClaimState::Legacy { registry, owner } => {
                match retain_native(&registry, owner, inputs, connection) {
                    Ok(viewer) => Ok(ExistingStoragePreparation {
                        destination: Destination::Legacy { registry },
                        viewer,
                    }),
                    Err(failure) => {
                        let NativeRetainFailure {
                            owner,
                            inputs,
                            error,
                        } = *failure;
                        Err(Box::new(ExistingStorageRetainFailure {
                            claim: StorageClaim {
                                state: ClaimState::Legacy { registry, owner },
                            },
                            inputs,
                            error,
                        }))
                    }
                }
            }
            ClaimState::Registered {
                registry,
                identity,
                paths,
                newly_claimed,
            } => match registry.retain_existing(&identity, inputs, connection) {
                Ok(viewer) => Ok(ExistingStoragePreparation {
                    destination: Destination::Registered {
                        registry,
                        identity,
                        newly_claimed,
                    },
                    viewer,
                }),
                Err(failure) => {
                    let RegistryRetainFailure { inputs, error } = *failure;
                    Err(Box::new(ExistingStorageRetainFailure {
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
                    }))
                }
            },
        }
    }
}
fn retain_native(
    registry: &StorageRegistry,
    owner: Box<LaunchStorage>,
    inputs: Inputs,
    connection: &reverie_host::worker_reports::WorkerLaunchConnection,
) -> Result<Arc<ExistingViewer>, Box<NativeRetainFailure>> {
    match registry.runtime.retain_existing_relay_for_connection(
        owner,
        inputs.plan,
        inputs.inspected,
        inputs.receipt,
        connection,
    ) {
        Ok(viewer) => Ok(Arc::new(viewer)),
        Err(failure) => {
            let (owner, plan, request, inspected, receipt, error) = failure.into_parts();
            Err(Box::new(NativeRetainFailure {
                owner,
                inputs: Inputs {
                    plan,
                    request,
                    inspected,
                    receipt,
                },
                error: error.into(),
            }))
        }
    }
}
impl StorageRegistry {
    fn retain_existing(
        &self,
        identity: &Arc<()>,
        inputs: Inputs,
        connection: &reverie_host::worker_reports::WorkerLaunchConnection,
    ) -> Result<Arc<ExistingViewer>, Box<RegistryRetainFailure>> {
        let mut entries = match self.lock(self.runtime.stop_deadline()) {
            Ok(entries) => entries,
            Err(error) => {
                return Err(Box::new(RegistryRetainFailure {
                    inputs,
                    error: error.into(),
                }));
            }
        };
        let index = match selected(&entries, identity) {
            Ok(index) => index,
            Err(error) => return Err(Box::new(RegistryRetainFailure { inputs, error })),
        };
        if !entries[index].writer_checked || !matches!(entries[index].owner, EntryOwner::Direct(_))
        {
            return Err(Box::new(RegistryRetainFailure {
                inputs,
                error: ExistingStorageError::Refused("WORKER_EXISTING_STORAGE_RETAINED"),
            }));
        }
        let mut entry = entries.remove(index);
        let EntryOwner::Direct(owner) = entry.owner else {
            unreachable!("checked same Direct box")
        };
        match retain_native(self, owner, inputs, connection) {
            Ok(viewer) => {
                entry.owner = EntryOwner::Existing(viewer.clone());
                entries.insert(index, entry);
                Ok(viewer)
            }
            Err(failure) => {
                let NativeRetainFailure {
                    owner,
                    inputs,
                    error,
                } = *failure;
                entry.owner = EntryOwner::Direct(owner);
                entries.insert(index, entry);
                Err(Box::new(RegistryRetainFailure { inputs, error }))
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
    observation: Option<&reverie_host::worker_laptop::ExistingStorageObservation>,
) -> Result<ExistingStorageReturned, ExistingStorageError> {
    let mut entries = registry.lock(registry.runtime.stop_deadline())?;
    let index = selected(&entries, identity)?;
    same(&entries[index], viewer)?;
    // Clone before borrowing the entry. All fallible checks and both actual
    // Host guards precede take; Direct replacement below is infallible.
    let retained = viewer.clone();
    let brand = observation.map(|_| Arc::new(()));
    let returned = match observation {
        Some(observation) => registry
            .runtime
            .reclaim_finalized_existing_relay(&retained, observation)?,
        None => registry.runtime.reclaim_existing_relay(&retained)?,
    };
    let (owner, plan, request, inspected, receipt, outcome) = returned.into_parts();
    entries[index].owner = match &brand {
        Some(brand) => EntryOwner::Finalizing(FinalizingStorage::Ready {
            owner,
            brand: brand.clone(),
        }),
        None => EntryOwner::Direct(owner),
    };
    Ok(ExistingStorageReturned {
        claim: registry.handle(&entries[index], newly_claimed),
        inputs: Inputs {
            plan,
            request,
            inspected,
            receipt,
        },
        outcome,
        finalization: observation.map(|observation| FinalStorageDecision {
            live: observation.is_live(),
            brand,
        }),
    })
}
fn reclaim_legacy(
    registry: &Arc<StorageRegistry>,
    viewer: &Arc<ExistingViewer>,
    observation: Option<&reverie_host::worker_laptop::ExistingStorageObservation>,
) -> Result<ExistingStorageReturned, ExistingStorageError> {
    let returned = match observation {
        Some(observation) => registry
            .runtime
            .reclaim_finalized_existing_relay(viewer, observation)?,
        None => registry.runtime.reclaim_existing_relay(viewer)?,
    };
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
        finalization: observation.map(|observation| FinalStorageDecision {
            live: observation.is_live(),
            brand: None,
        }),
    })
}
