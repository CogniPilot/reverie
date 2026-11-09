//! Ordinary by-name cleanup retains the SAME box in the existing registry.
//! Only the actual caller supplies its separate common stop admission.
use super::*;
use reverie_host::{
    worker_launch::{ExistingLaptopInspection, ObservedCreatePlan},
    worker_source_stop::{OrdinaryLaptopStop, StoppedLaptopRemoval},
};
type RetainFailure = Box<(
    ObservedCreatePlan,
    Option<ExistingLaptopInspection>,
    StorageWorkflowError,
)>;
pub(in crate::installing_broker) struct OrdinaryStopPreparation {
    predecessor_office: Option<reverie_host::office::OfficePhone>,
    destination: ClaimDestination,
    native: Arc<Mutex<OrdinaryLaptopStop>>,
}
pub(in crate::installing_broker) struct OrdinaryStopReturned {
    predecessor_office: Option<reverie_host::office::OfficePhone>,
    claim: StorageClaim,
    plan: ObservedCreatePlan,
    previous: Option<ExistingLaptopInspection>,
    removal: StoppedLaptopRemoval,
}
pub(in crate::installing_broker) struct OrdinaryStopRetainFailure {
    claim: StorageClaim,
    plan: ObservedCreatePlan,
    previous: Option<ExistingLaptopInspection>,
    cause: StorageWorkflowError,
}
pub(in crate::installing_broker) struct OrdinaryStopReclaimFailure {
    preparation: OrdinaryStopPreparation,
    cause: StorageWorkflowError,
}
impl OrdinaryStopRetainFailure {
    pub(in crate::installing_broker) fn into_parts(
        self: Box<Self>,
    ) -> (
        StorageClaim,
        ObservedCreatePlan,
        Option<ExistingLaptopInspection>,
        StorageWorkflowError,
    ) {
        (self.claim, self.plan, self.previous, self.cause)
    }
}
impl OrdinaryStopReclaimFailure {
    pub(in crate::installing_broker) fn into_parts(
        self,
    ) -> (OrdinaryStopPreparation, StorageWorkflowError) {
        (self.preparation, self.cause)
    }
}
impl OrdinaryStopReturned {
    pub(in crate::installing_broker) fn into_cold_parts(
        self,
    ) -> (
        StorageClaim,
        ObservedCreatePlan,
        Option<ExistingLaptopInspection>,
        StoppedLaptopRemoval,
        Option<reverie_host::office::OfficePhone>,
    ) {
        // The actual observed input remains retained through confirmed stop;
        // the removal owner carries its stopped identity, not its DATA row.
        (
            self.claim,
            self.plan,
            self.previous,
            self.removal,
            self.predecessor_office,
        )
    }
}
impl OrdinaryStopPreparation {
    pub(in crate::installing_broker) fn stop_after_admission(
        &self,
    ) -> Result<(), StorageWorkflowError> {
        let registry = self.destination.registry();
        self.check_entry()?;
        self.native
            .try_lock()
            .map_err(|_| StorageWorkflowError::refused("WORKER_ORDINARY_STOP_RETAINED"))?
            .stop_after_admission(&registry.runtime)
            .map_err(Into::into)
    }
    fn check_entry(&self) -> Result<(), StorageWorkflowError> {
        if let ClaimDestination::Registered {
            registry, identity, ..
        } = &self.destination
        {
            let entries = registry.lock(registry.runtime.stop_deadline())?;
            let index = selected(&entries, identity)?;
            same_native(&entries[index], &self.native)?;
        }
        Ok(())
    }
    pub(in crate::installing_broker) fn settle_native(
        &self,
        end: Instant,
    ) -> Result<(), StorageWorkflowError> {
        self.check_entry()?;
        self.native
            .try_lock()
            .map_err(|_| StorageWorkflowError::refused("WORKER_ORDINARY_STOP_RETAINED"))?
            .settle_native(&self.destination.registry().runtime, end)
            .map_err(Into::into)
    }
    pub(in crate::installing_broker) fn reclaim(
        mut self,
        end: Instant,
    ) -> Result<OrdinaryStopReturned, Box<OrdinaryStopReclaimFailure>> {
        let result = match &self.destination {
            ClaimDestination::Legacy { registry } => self
                .native
                .try_lock()
                .map_err(|_| StorageWorkflowError::refused("WORKER_ORDINARY_STOP_RETAINED"))
                .and_then(|mut native| {
                    let (owner, plan, previous, removal) = native
                        .take_stopped(&registry.runtime, end)?
                        .into_cold_parts();
                    Ok(OrdinaryStopReturned {
                        predecessor_office: self.predecessor_office.take(),
                        claim: StorageClaim {
                            state: ClaimState::Legacy {
                                registry: registry.clone(),
                                owner,
                            },
                        },
                        plan,
                        previous,
                        removal,
                    })
                }),
            ClaimDestination::Registered {
                registry,
                identity,
                newly_claimed,
            } => registry
                .reclaim_ordinary_stop(identity, &self.native, *newly_claimed, end)
                .map(|mut returned| {
                    returned.predecessor_office = self.predecessor_office.take();
                    returned
                }),
        };
        result.map_err(|cause| {
            Box::new(OrdinaryStopReclaimFailure {
                preparation: self,
                cause,
            })
        })
    }
}
impl StorageClaim {
    pub(in crate::installing_broker) fn retain_ordinary_stop(
        self,
        plan: ObservedCreatePlan,
        previous: ExistingLaptopInspection,
    ) -> Result<OrdinaryStopPreparation, Box<OrdinaryStopRetainFailure>> {
        self.retain_ordinary_stop_input(plan, Some(previous))
    }
    /// No absence is claimed. The same resource's fixed native consumer must
    /// perform its complete initial inspect/census after actual stop admission.
    pub(in crate::installing_broker) fn retain_unobserved_ordinary_stop(
        self,
        plan: ObservedCreatePlan,
    ) -> Result<OrdinaryStopPreparation, Box<OrdinaryStopRetainFailure>> {
        self.retain_ordinary_stop_input(plan, None)
    }
    fn retain_ordinary_stop_input(
        self,
        plan: ObservedCreatePlan,
        previous: Option<ExistingLaptopInspection>,
    ) -> Result<OrdinaryStopPreparation, Box<OrdinaryStopRetainFailure>> {
        match self.state {
            ClaimState::Started(owner) => retain_started(owner, plan, previous),
            ClaimState::Legacy { registry, owner } => {
                match retain_native(&registry.runtime, owner, plan, previous) {
                    Ok(native) => Ok(OrdinaryStopPreparation {
                        predecessor_office: None,
                        destination: ClaimDestination::Legacy { registry },
                        native: Arc::new(Mutex::new(native)),
                    }),
                    Err(failure) => {
                        let (owner, plan, previous, cause) = failure.into_parts();
                        Err(Box::new(OrdinaryStopRetainFailure {
                            claim: StorageClaim {
                                state: ClaimState::Legacy { registry, owner },
                            },
                            plan,
                            previous,
                            cause: cause.into(),
                        }))
                    }
                }
            }
            ClaimState::Registered {
                registry,
                identity,
                paths,
                newly_claimed,
            } => {
                let destination = ClaimDestination::Registered {
                    registry: registry.clone(),
                    identity: identity.clone(),
                    newly_claimed,
                };
                match registry.retain_ordinary_stop(&identity, plan, previous) {
                    Ok(native) => Ok(OrdinaryStopPreparation {
                        predecessor_office: None,
                        destination,
                        native,
                    }),
                    Err(failure) => {
                        let (plan, previous, cause) = *failure;
                        Err(Box::new(OrdinaryStopRetainFailure {
                            claim: StorageClaim {
                                state: ClaimState::Registered {
                                    registry,
                                    identity,
                                    paths,
                                    newly_claimed,
                                },
                            },
                            plan,
                            previous,
                            cause,
                        }))
                    }
                }
            }
        }
    }
}
impl StorageRegistry {
    fn retain_ordinary_stop(
        &self,
        identity: &Arc<()>,
        plan: ObservedCreatePlan,
        previous: Option<ExistingLaptopInspection>,
    ) -> Result<Arc<Mutex<OrdinaryLaptopStop>>, RetainFailure> {
        let mut entries = match self.lock(self.runtime.stop_deadline()) {
            Ok(entries) => entries,
            Err(cause) => return Err(Box::new((plan, previous, cause))),
        };
        let index = match selected(&entries, identity) {
            Ok(index) => index,
            Err(cause) => return Err(Box::new((plan, previous, cause))),
        };
        if !entries[index].writer_checked || !matches!(entries[index].owner, EntryOwner::Direct(_))
        {
            return Err(Box::new((
                plan,
                previous,
                StorageWorkflowError::refused("WORKER_ORDINARY_STOP_RETAINED"),
            )));
        }
        let mut entry = entries.remove(index);
        let EntryOwner::Direct(owner) = entry.owner else {
            unreachable!("checked actual Direct owner")
        };
        match retain_native(&self.runtime, owner, plan, previous) {
            Ok(native) => {
                let native = Arc::new(Mutex::new(native));
                entry.owner = EntryOwner::OrdinaryStop(native.clone());
                entries.insert(index, entry);
                Ok(native)
            }
            Err(failure) => {
                let (owner, plan, previous, cause) = failure.into_parts();
                entry.owner = EntryOwner::Direct(owner);
                entries.insert(index, entry);
                Err(Box::new((plan, previous, cause.into())))
            }
        }
    }
    fn reclaim_ordinary_stop(
        self: &Arc<Self>,
        identity: &Arc<()>,
        native: &Arc<Mutex<OrdinaryLaptopStop>>,
        newly_claimed: bool,
        end: Instant,
    ) -> Result<OrdinaryStopReturned, StorageWorkflowError> {
        let mut entries = self.lock(self.runtime.stop_deadline())?;
        let index = selected(&entries, identity)?;
        same_native(&entries[index], native)?;
        let mut native = native
            .try_lock()
            .map_err(|_| StorageWorkflowError::refused("WORKER_ORDINARY_STOP_RETAINED"))?;
        let (owner, plan, previous, removal) =
            native.take_stopped(&self.runtime, end)?.into_cold_parts();
        entries[index].owner = EntryOwner::Direct(owner);
        Ok(OrdinaryStopReturned {
            predecessor_office: None,
            claim: self.handle(&entries[index], newly_claimed),
            plan,
            previous,
            removal,
        })
    }
}
fn retain_native(
    runtime: &WorkerRuntime,
    owner: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    previous: Option<ExistingLaptopInspection>,
) -> Result<
    OrdinaryLaptopStop,
    Box<reverie_host::worker_source_stop::OrdinaryLaptopStopRetainFailure>,
> {
    match previous {
        Some(previous) => runtime.retain_ordinary_laptop_stop_for_worker(owner, plan, previous),
        None => runtime.retain_unobserved_ordinary_laptop_stop_for_worker(owner, plan),
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
    native: &Arc<Mutex<OrdinaryLaptopStop>>,
) -> Result<(), StorageWorkflowError> {
    if matches!(&entry.owner, EntryOwner::OrdinaryStop(actual) if Arc::ptr_eq(actual, native)) {
        Ok(())
    } else {
        Err(StorageWorkflowError::refused(
            "WORKER_ORDINARY_STOP_CHANGED",
        ))
    }
}

fn retain_started(
    owner: Box<super::started::StartedClaim>,
    plan: ObservedCreatePlan,
    previous: Option<ExistingLaptopInspection>,
) -> Result<OrdinaryStopPreparation, Box<OrdinaryStopRetainFailure>> {
    let mut inputs = Some((plan, previous));
    match transfer_started(&owner, &mut inputs) {
        Ok((native, office)) => Ok(OrdinaryStopPreparation {
            destination: owner.destination,
            native,
            predecessor_office: Some(office),
        }),
        Err(cause) => {
            let (plan, previous) = inputs.expect("all refusals return original observations");
            Err(Box::new(OrdinaryStopRetainFailure {
                claim: StorageClaim {
                    state: ClaimState::Started(owner),
                },
                plan,
                previous,
                cause,
            }))
        }
    }
}
fn transfer_started(
    owner: &super::started::StartedClaim,
    inputs: &mut Option<(ObservedCreatePlan, Option<ExistingLaptopInspection>)>,
) -> Result<
    (
        Arc<Mutex<OrdinaryLaptopStop>>,
        reverie_host::office::OfficePhone,
    ),
    StorageWorkflowError,
> {
    if inputs.as_ref().expect("original inputs").1.is_none() {
        return Err(StorageWorkflowError::refused(
            "WORKER_STARTED_INITIAL_OBSERVATION_REQUIRED",
        ));
    }
    let entry = owner.stop_entry()?;
    let registry = owner.destination.registry();
    let (plan, previous) = inputs.take().expect("checked original inputs");
    let transferred = match registry
        .runtime
        .transfer_started_laptop_ordinary_stop_for_worker(
            &owner.owner.created,
            plan,
            previous.expect("actual original inspection"),
            &owner.connection,
        ) {
        Ok(transferred) => transferred,
        Err(failure) => {
            let (plan, original, cause) = failure.into_parts();
            *inputs = Some((plan, Some(original)));
            return Err(cause.into());
        }
    };
    let (native, office, _original_request_data) = transferred.into_parts();
    let native = Arc::new(Mutex::new(native));
    entry.publish_ordinary(native.clone());
    Ok((native, office))
}
