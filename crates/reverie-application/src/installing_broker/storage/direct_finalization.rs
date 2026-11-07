//! Direct cleanup keeps the SAME registered Box fenced until an exact native
//! observation and the outer handler's actual writer cleanup have concluded.
use super::*;
use reverie_host::{
    worker_laptop::{DirectStorageFinalizer, DirectStorageObservation},
    worker_launch::ObservedCreatePlan,
};
mod error;
pub(in crate::installing_broker) use error::{
    DirectStorageFinishFailure, DirectStorageRetainFailure,
};
enum Destination {
    Legacy {
        registry: Arc<StorageRegistry>,
        owner: DirectStorageFinalizer,
    },
    Registered {
        registry: Arc<StorageRegistry>,
        identity: Arc<()>,
        brand: Arc<()>,
        newly_claimed: bool,
    },
}
pub(in crate::installing_broker) struct DirectStoragePreparation {
    destination: Destination,
}
struct Returned {
    claim: StorageClaim,
    plan: ObservedCreatePlan,
    decision: FinalStorageDecision,
}
pub(in crate::installing_broker) struct DirectStorageFinished {
    plan: ObservedCreatePlan,
    retained: bool,
}
impl DirectStorageFinished {
    pub(in crate::installing_broker) fn into_parts(self) -> (ObservedCreatePlan, bool) {
        (self.plan, self.retained)
    }
}
impl StorageClaim {
    pub(in crate::installing_broker) fn retain_direct_final_storage(
        self,
        plan: ObservedCreatePlan,
    ) -> Result<DirectStoragePreparation, Box<DirectStorageRetainFailure>> {
        let destination = match self.state {
            ClaimState::Legacy { registry, owner } => {
                match registry.runtime.retain_direct_final_storage(owner, plan) {
                    Ok(owner) => Destination::Legacy { registry, owner },
                    Err(failure) => {
                        let (owner, plan, cause) = failure.into_parts();
                        return Err(Box::new(DirectStorageRetainFailure {
                            claim: StorageClaim {
                                state: ClaimState::Legacy { registry, owner },
                            },
                            plan,
                            cause: cause.into(),
                        }));
                    }
                }
            }
            ClaimState::Registered {
                registry,
                identity,
                paths,
                newly_claimed,
            } => match retain_registered(&registry, &identity, plan) {
                Ok(brand) => Destination::Registered {
                    registry,
                    identity,
                    brand,
                    newly_claimed,
                },
                Err(failure) => {
                    let (plan, cause) = *failure;
                    return Err(Box::new(DirectStorageRetainFailure {
                        claim: StorageClaim {
                            state: ClaimState::Registered {
                                registry,
                                identity,
                                paths,
                                newly_claimed,
                            },
                        },
                        plan,
                        cause,
                    }));
                }
            },
        };
        Ok(DirectStoragePreparation { destination })
    }
}
fn index(entries: &[Entry], identity: &Arc<()>) -> Result<usize, StorageWorkflowError> {
    entries
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        .ok_or_else(|| StorageWorkflowError::refused("WORKER_DIRECT_STORAGE_CLAIM_CHANGED"))
}
fn retain_registered(
    registry: &Arc<StorageRegistry>,
    identity: &Arc<()>,
    plan: ObservedCreatePlan,
) -> Result<Arc<()>, Box<(ObservedCreatePlan, StorageWorkflowError)>> {
    let mut entries = match registry.lock(registry.runtime.stop_deadline()) {
        Ok(entries) => entries,
        Err(cause) => return Err(Box::new((plan, cause))),
    };
    let index = match index(&entries, identity) {
        Ok(index) => index,
        Err(cause) => return Err(Box::new((plan, cause))),
    };
    if !entries[index].writer_checked || !matches!(entries[index].owner, EntryOwner::Direct(_)) {
        return Err(Box::new((
            plan,
            StorageWorkflowError::refused("WORKER_DIRECT_STORAGE_RETAINED"),
        )));
    }
    let mut entry = entries.remove(index);
    let EntryOwner::Direct(owner) = entry.owner else {
        unreachable!("same checked Direct Box")
    };
    match registry.runtime.retain_direct_final_storage(owner, plan) {
        Ok(owner) => {
            let brand = Arc::new(());
            entry.owner = EntryOwner::Finalizing(FinalizingStorage::Direct {
                owner: Arc::new(Mutex::new(owner)),
                brand: brand.clone(),
            });
            entries.insert(index, entry);
            Ok(brand)
        }
        Err(failure) => {
            let (owner, plan, cause) = failure.into_parts();
            entry.owner = EntryOwner::Direct(owner);
            entries.insert(index, entry);
            Err(Box::new((plan, cause.into())))
        }
    }
}
impl DirectStoragePreparation {
    pub(in crate::installing_broker) fn observe(
        &mut self,
    ) -> Result<DirectStorageObservation, StorageWorkflowError> {
        match &mut self.destination {
            Destination::Legacy { registry, owner } => Ok(owner.observe(&registry.runtime)?),
            Destination::Registered {
                registry,
                identity,
                brand,
                ..
            } => {
                let owner = registered_owner(registry, identity, brand)?;
                let result = owner
                    .try_lock()
                    .map_err(|_| StorageWorkflowError::refused("WORKER_DIRECT_STORAGE_IN_USE"))?
                    .observe(&registry.runtime);
                Ok(result?)
            }
        }
    }
    /// Invoke only after the whole real handler's native/Office cleanup. This
    /// consumes the same observation; an error retains the original phase.
    pub(in crate::installing_broker) fn finish(
        self,
        observation: &DirectStorageObservation,
        end: Instant,
    ) -> Result<DirectStorageFinished, Box<DirectStorageFinishFailure>> {
        let returned = self.reclaim(observation).map_err(|(owner, cause)| {
            Box::new(DirectStorageFinishFailure {
                owner: error::Owner::Preparing(Box::new(owner)),
                cause,
            })
        })?;
        returned.finish(end)
    }
    fn reclaim(
        self,
        observation: &DirectStorageObservation,
    ) -> Result<Returned, (Self, StorageWorkflowError)> {
        match self.destination {
            Destination::Legacy {
                registry,
                mut owner,
            } => match owner.reclaim(&registry.runtime, observation) {
                Ok((owner, plan, live)) => Ok(Returned {
                    claim: StorageClaim {
                        state: ClaimState::Legacy { registry, owner },
                    },
                    plan,
                    decision: FinalStorageDecision { live, brand: None },
                }),
                Err(cause) => Err((
                    Self {
                        destination: Destination::Legacy { registry, owner },
                    },
                    cause.into(),
                )),
            },
            Destination::Registered {
                registry,
                identity,
                brand,
                newly_claimed,
            } => {
                match reclaim_registered(&registry, &identity, &brand, newly_claimed, observation) {
                    Ok(returned) => Ok(returned),
                    Err(cause) => Err((
                        Self {
                            destination: Destination::Registered {
                                registry,
                                identity,
                                brand,
                                newly_claimed,
                            },
                        },
                        cause,
                    )),
                }
            }
        }
    }
}
/// Clone only the actual counted record under a short registry guard. Native
/// observation stays outside that global guard; this creates no new owner.
fn registered_owner(
    registry: &StorageRegistry,
    identity: &Arc<()>,
    brand: &Arc<()>,
) -> Result<Arc<Mutex<DirectStorageFinalizer>>, StorageWorkflowError> {
    let entries = registry.lock(registry.runtime.stop_deadline())?;
    let selected = index(&entries, identity)?;
    let EntryOwner::Finalizing(FinalizingStorage::Direct {
        owner,
        brand: actual,
    }) = &entries[selected].owner
    else {
        return Err(StorageWorkflowError::refused(
            "WORKER_DIRECT_STORAGE_CHANGED",
        ));
    };
    if !Arc::ptr_eq(actual, brand) {
        return Err(StorageWorkflowError::refused("WORKER_DIRECT_STORAGE_BRAND"));
    }
    Ok(owner.clone())
}
fn reclaim_registered(
    registry: &Arc<StorageRegistry>,
    identity: &Arc<()>,
    expected: &Arc<()>,
    newly_claimed: bool,
    observation: &DirectStorageObservation,
) -> Result<Returned, StorageWorkflowError> {
    let mut entries = registry.lock(registry.runtime.stop_deadline())?;
    let index = index(&entries, identity)?;
    let EntryOwner::Finalizing(FinalizingStorage::Direct { owner, brand }) = &entries[index].owner
    else {
        return Err(StorageWorkflowError::refused(
            "WORKER_DIRECT_STORAGE_CHANGED",
        ));
    };
    if !Arc::ptr_eq(brand, expected) {
        return Err(StorageWorkflowError::refused("WORKER_DIRECT_STORAGE_BRAND"));
    }
    let actual = owner.clone();
    let brand = brand.clone();
    let (owner, plan, live) = actual
        .try_lock()
        .map_err(|_| StorageWorkflowError::refused("WORKER_DIRECT_STORAGE_IN_USE"))?
        .reclaim(&registry.runtime, observation)?;
    // Native extraction is complete and its old Arc is now a consumed phase.
    // All remaining publication is infallible under this exact registry guard.
    entries[index].owner = EntryOwner::Finalizing(FinalizingStorage::Ready {
        owner,
        brand: brand.clone(),
    });
    Ok(Returned {
        claim: registry.handle(&entries[index], newly_claimed),
        plan,
        decision: FinalStorageDecision {
            live,
            brand: Some(brand),
        },
    })
}
impl Returned {
    fn finish(
        mut self,
        end: Instant,
    ) -> Result<DirectStorageFinished, Box<DirectStorageFinishFailure>> {
        if let ClaimState::Registered {
            registry, identity, ..
        } = &self.claim.state
        {
            return match super::finalization::finish_registered(
                registry,
                identity,
                &self.decision,
                end,
            ) {
                Ok(retained) => Ok(DirectStorageFinished {
                    plan: self.plan,
                    retained,
                }),
                Err(cause) => Err(Box::new(DirectStorageFinishFailure {
                    owner: error::Owner::Returned(Box::new(self)),
                    cause,
                })),
            };
        }
        let Self {
            claim,
            plan,
            decision,
        } = self;
        match claim.release(end) {
            Ok(()) => Ok(DirectStorageFinished {
                plan,
                retained: false,
            }),
            Err(failure) => {
                let (claim, cause) = failure.into_parts();
                self = Self {
                    claim,
                    plan,
                    decision,
                };
                Err(Box::new(DirectStorageFinishFailure {
                    owner: error::Owner::Returned(Box::new(self)),
                    cause,
                }))
            }
        }
    }
}
