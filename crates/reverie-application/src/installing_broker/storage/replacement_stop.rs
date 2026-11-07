//! Transfer the SAME claim into the reviewed exact-process stop owner. Actual
//! launch admission and original ordering remain obligations of the J caller.
use super::*;
use reverie_contracts::worker_config::WorkerPolicyDigest;
use reverie_host::{
    worker_launch::{ExistingProcessIncarnation, ObservedCreatePlan},
    worker_source_stop::{OrdinaryReplacementStop, StoppedLaptopRemoval},
};
mod error;
pub use error::{ReplacementStopReclaimFailure, ReplacementStopRetainFailure};

#[must_use = "keep the actual stop and original resource through uncertainty"]
pub struct ReplacementStopPreparation {
    destination: ClaimDestination,
    paths: StoragePaths,
    native: Arc<Mutex<OrdinaryReplacementStop>>,
}
#[must_use = "retain the same returned storage and original observations"]
pub struct ReplacementStopReturned {
    claim: StorageClaim,
    plan: ObservedCreatePlan,
    process: ExistingProcessIncarnation,
    removal: StoppedLaptopRemoval,
}
struct RegistryRetainFailure {
    plan: ObservedCreatePlan,
    process: ExistingProcessIncarnation,
    cause: StorageWorkflowError,
}
impl ReplacementStopReturned {
    pub fn into_parts(self) -> (StorageClaim, ObservedCreatePlan, ExistingProcessIncarnation) {
        (self.claim, self.plan, self.process)
    }
    pub(in crate::installing_broker) fn into_cold_parts(self)
        -> (StorageClaim, ObservedCreatePlan, ExistingProcessIncarnation, StoppedLaptopRemoval) {
        (self.claim, self.plan, self.process, self.removal)
    }
}
impl ReplacementStopPreparation {
    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }
    fn native(&self) -> Result<MutexGuard<'_, OrdinaryReplacementStop>, StorageWorkflowError> {
        if let ClaimDestination::Registered {
            registry, identity, ..
        } = &self.destination
        {
            let entries = registry.lock(registry.runtime.stop_deadline())?;
            let index = selected(&entries, identity)?;
            same_native(&entries[index], &self.native)?;
        }
        self.native
            .try_lock()
            .map_err(|_| StorageWorkflowError::refused("WORKER_REPLACEMENT_STOP_RETAINED"))
    }
    /// Fresh original-name headers BEFORE the actual App late policy resolver.
    /// The global storage registry mutex is released before native I/O.
    pub fn inspect(&self) -> Result<(), StorageWorkflowError> {
        self.native()?
            .inspect(&self.destination.registry().runtime)
            .map_err(Into::into)
    }
    pub fn refuse_policy(&self) -> Result<(), StorageWorkflowError> {
        self.native()?
            .refuse_policy(&self.destination.registry().runtime)
            .map_err(Into::into)
    }
    pub fn stop_after_policy(
        &self,
        policy: &WorkerPolicyDigest,
    ) -> Result<(), StorageWorkflowError> {
        self.native()?
            .stop_after_policy(&self.destination.registry().runtime, policy)
            .map_err(Into::into)
    }
    /// Local native settlement cannot upgrade unknown stop to stopped proof.
    pub fn settle_native(&self, end: Instant) -> Result<(), StorageWorkflowError> {
        self.native()?
            .settle_native(&self.destination.registry().runtime, end)
            .map_err(Into::into)
    }
    /// Restore only this SAME prevalidated entry. Native extraction and claim
    /// publication have no fallible gap and do not release the employee lease.
    pub fn reclaim(
        self,
        end: Instant,
    ) -> Result<ReplacementStopReturned, Box<ReplacementStopReclaimFailure>> {
        let returned = match &self.destination {
            ClaimDestination::Legacy { registry } => self
                .native
                .try_lock()
                .map_err(|_| StorageWorkflowError::refused("WORKER_REPLACEMENT_STOP_RETAINED"))
                .and_then(|mut native| {
                    let (owner, plan, process, removal) =
                        native.take_stopped(&registry.runtime, end)?.into_cold_parts();
                    Ok(ReplacementStopReturned {
                        claim: StorageClaim {
                            state: ClaimState::Legacy {
                                registry: registry.clone(),
                                owner,
                            },
                        },
                        plan,
                        process,
                        removal,
                    })
                }),
            ClaimDestination::Registered {
                registry,
                identity,
                newly_claimed,
            } => registry.reclaim_replacement_stop(identity, &self.native, *newly_claimed, end),
        };
        returned.map_err(|cause| {
            Box::new(ReplacementStopReclaimFailure {
                preparation: self,
                cause,
            })
        })
    }
}
impl StorageClaim {
    /// Resource transfer only. The real ordinary caller must perform its SAME
    /// admission stop fence before this transition and retain its lifecycle/J.
    /// Raw request IDs, paths and policy DATA cannot construct these inputs.
    pub fn retain_replacement_stop(
        self,
        plan: ObservedCreatePlan,
        process: ExistingProcessIncarnation,
        end: Option<Instant>,
    ) -> Result<ReplacementStopPreparation, Box<ReplacementStopRetainFailure>> {
        let paths = self.paths().clone();
        match self.state {
            ClaimState::Legacy { registry, owner } => match registry
                .runtime
                .retain_ordinary_replacement_stop(owner, plan, process, end)
            {
                Ok(native) => Ok(ReplacementStopPreparation {
                    destination: ClaimDestination::Legacy { registry },
                    paths,
                    native: Arc::new(Mutex::new(native)),
                }),
                Err(failure) => {
                    let (owner, plan, process, cause) = failure.into_parts();
                    Err(Box::new(ReplacementStopRetainFailure {
                        claim: StorageClaim {
                            state: ClaimState::Legacy { registry, owner },
                        },
                        plan,
                        process,
                        cause: cause.into(),
                    }))
                }
            },
            ClaimState::Registered {
                registry,
                identity,
                newly_claimed,
                ..
            } => {
                let destination = ClaimDestination::Registered {
                    registry: registry.clone(),
                    identity: identity.clone(),
                    newly_claimed,
                };
                match registry.retain_replacement_stop(&identity, plan, process, end) {
                    Ok(native) => Ok(ReplacementStopPreparation {
                        destination,
                        paths,
                        native,
                    }),
                    Err(failure) => {
                        let RegistryRetainFailure {
                            plan,
                            process,
                            cause,
                        } = *failure;
                        Err(Box::new(ReplacementStopRetainFailure {
                            claim: StorageClaim {
                                state: ClaimState::Registered {
                                    registry,
                                    identity,
                                    paths,
                                    newly_claimed,
                                },
                            },
                            plan,
                            process,
                            cause,
                        }))
                    }
                }
            }
        }
    }
}
impl StorageRegistry {
    fn retain_replacement_stop(
        &self,
        identity: &Arc<()>,
        plan: ObservedCreatePlan,
        process: ExistingProcessIncarnation,
        end: Option<Instant>,
    ) -> Result<Arc<Mutex<OrdinaryReplacementStop>>, Box<RegistryRetainFailure>> {
        // Select and mutate under the SAME guard; no earlier numeric index
        // can refer to a removed/replaced entry.
        let mut entries = match self.lock(self.runtime.stop_deadline()) {
            Ok(entries) => entries,
            Err(cause) => {
                return Err(Box::new(RegistryRetainFailure {
                    plan,
                    process,
                    cause,
                }));
            }
        };
        let index = match selected(&entries, identity) {
            Ok(index) => index,
            Err(cause) => {
                return Err(Box::new(RegistryRetainFailure {
                    plan,
                    process,
                    cause,
                }));
            }
        };
        if !entries[index].writer_checked || !matches!(entries[index].owner, EntryOwner::Direct(_))
        {
            return Err(Box::new(RegistryRetainFailure {
                plan,
                process,
                cause: StorageWorkflowError::refused("WORKER_REPLACEMENT_STOP_RETAINED"),
            }));
        }
        let mut entry = entries.remove(index);
        let EntryOwner::Direct(owner) = entry.owner else {
            unreachable!("checked direct original")
        };
        match self
            .runtime
            .retain_ordinary_replacement_stop(owner, plan, process, end)
        {
            Ok(native) => {
                let native = Arc::new(Mutex::new(native));
                entry.owner = EntryOwner::ReplacementStop(native.clone());
                entries.insert(index, entry);
                Ok(native)
            }
            Err(failure) => {
                let (owner, plan, process, cause) = failure.into_parts();
                entry.owner = EntryOwner::Direct(owner);
                entries.insert(index, entry);
                Err(Box::new(RegistryRetainFailure {
                    plan,
                    process,
                    cause: cause.into(),
                }))
            }
        }
    }
    fn reclaim_replacement_stop(
        self: &Arc<Self>,
        identity: &Arc<()>,
        native: &Arc<Mutex<OrdinaryReplacementStop>>,
        newly_claimed: bool,
        end: Instant,
    ) -> Result<ReplacementStopReturned, StorageWorkflowError> {
        let mut entries = self.lock(self.runtime.stop_deadline())?;
        let index = selected(&entries, identity)?;
        same_native(&entries[index], native)?;
        let mut native = native
            .try_lock()
            .map_err(|_| StorageWorkflowError::refused("WORKER_REPLACEMENT_STOP_RETAINED"))?;
        let (owner, plan, process, removal) = native.take_stopped(&self.runtime, end)?.into_cold_parts();
        entries[index].owner = EntryOwner::Direct(owner);
        Ok(ReplacementStopReturned {
            claim: self.handle(&entries[index], newly_claimed),
            plan,
            process,
            removal,
        })
    }
}
fn selected(entries: &[Entry], identity: &Arc<()>) -> Result<usize, StorageWorkflowError> {
    entries
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        .ok_or_else(|| StorageWorkflowError::refused("WORKER_STORAGE_CLAIM_CHANGED"))
}
fn same_native(
    entry: &Entry,
    native: &Arc<Mutex<OrdinaryReplacementStop>>,
) -> Result<(), StorageWorkflowError> {
    if matches!(&entry.owner, EntryOwner::ReplacementStop(actual) if Arc::ptr_eq(actual, native)) {
        Ok(())
    } else {
        Err(StorageWorkflowError::refused(
            "WORKER_REPLACEMENT_STOP_CHANGED",
        ))
    }
}
