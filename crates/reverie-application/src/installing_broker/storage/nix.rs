//! Move real registry resources into the existing same-runtime Nix owner. No
//! handle/status/path constructs admission, owner authorization or a laptop.
use super::ClaimDestination as ReturnTo;
use super::*;
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_host::worker_nix::{NixDisposition, NixError, NixProgress, NixStoreGuard, NixWorkflow};
mod cold;
mod error;
mod network;
pub(in crate::installing_broker) use network::{CreatedStorageReturned, CreatedStorageFinishFailure};
pub use error::{NixStorageError, NixStorageReclaimFailure, NixStorageRetainFailure};
pub use network::{
    NetworkStorageError, NetworkStoragePreparation, NetworkStorageReclaimFailure,
    NetworkStorageRetainFailure, NetworkStorageReturned,
};

/// A move-only actual resource transition. While the actual Registry/Runtime
/// remains retained, dropping this handle leaves its workflow resources held.
/// Last-owner/process exit is NOT confirmed shutdown or global writer release;
/// the complete installing lifetime must retain unknowns until real settlement.
#[must_use = "retain until checked one-shot resource reclamation"]
pub struct NixStoragePreparation {
    destination: ReturnTo,
    paths: StoragePaths,
    workflow: NixWorkflow,
}
impl NixStoragePreparation {
    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }
    /// Original pre-unlock rootless-image phase on the same held Nix record.
    /// The actual launch caller retains its lifecycle guard until this returns.
    pub fn qualify_rootless_image(
        &self,
        end: std::time::Instant,
    ) -> Result<reverie_host::worker_nix::NixImageQualification, NixStorageError> {
        if let ReturnTo::Registered {
            registry, identity, ..
        } = &self.destination
        {
            registry.check_nix(identity, &self.workflow)?;
        }
        Ok(self
            .destination
            .registry()
            .runtime
            .qualify_prepared_nix_image(&self.workflow, end)?)
    }
    /// Run only after releasing the installing lifecycle/registry mutex. The
    /// fixed Host workflow owns commands, first-stop cleanup and real guards.
    pub fn run(&self) -> Result<NixProgress, NixStorageError> {
        if let ReturnTo::Registered {
            registry, identity, ..
        } = &self.destination
        {
            registry.check_nix(identity, &self.workflow)?;
        }
        Ok(self
            .destination
            .registry()
            .runtime
            .run_nix_store(&self.workflow)?)
    }
    /// Restore the SAME owners only after the Host record is known settled.
    /// Unknowns return this exact handle and retain all native resources.
    pub fn reclaim(self) -> Result<NixStorageReturned, Box<NixStorageReclaimFailure>> {
        let result = match &self.destination {
            ReturnTo::Legacy { registry } => registry
                .runtime
                .reclaim_nix_store(self.workflow.clone())
                .map(|returned| {
                    let prepared_store = returned.prepared_path().map(std::path::Path::to_owned);
                    let (guard, storage, outcome) = returned.into_parts();
                    NixStorageReturned {
                        claim: StorageClaim {
                            state: ClaimState::Legacy {
                                registry: registry.clone(),
                                owner: Box::new(storage),
                            },
                        },
                        guard,
                        outcome,
                        prepared_store,
                    }
                })
                .map_err(|failure| NixStorageError::from(failure.into_parts().1)),
            ReturnTo::Registered {
                registry,
                identity,
                newly_claimed,
            } => registry.reclaim_nix(identity, &self.workflow, *newly_claimed),
        };
        match result {
            Ok(returned) => Ok(returned),
            Err(error) => Err(Box::new(NixStorageReclaimFailure {
                preparation: self,
                error,
            })),
        }
    }
}
#[must_use = "retain restored storage and the actual Nix guard through the next phase"]
pub struct NixStorageReturned {
    claim: StorageClaim,
    guard: NixStoreGuard,
    outcome: Result<NixDisposition, NixError>,
    prepared_store: Option<std::path::PathBuf>,
}
impl NixStorageReturned {
    /// Exact successful helper output, not a later path lookup or permission.
    pub fn prepared_path(&self) -> Option<&std::path::Path> {
        self.prepared_store.as_deref()
    }
    pub fn into_parts(
        self,
    ) -> (
        StorageClaim,
        NixStoreGuard,
        Result<NixDisposition, NixError>,
    ) {
        (self.claim, self.guard, self.outcome)
    }
}
impl StorageClaim {
    /// Transfer actual held storage and a real raw-config Nix guard before any
    /// helper query. `prepared` is the later effective-config DATA snapshot; it
    /// cannot manufacture either resource or authorize the installing sequence.
    pub fn retain_nix(
        self,
        guard: NixStoreGuard,
        prepared: EffectiveWorkerConfig,
    ) -> Result<NixStoragePreparation, Box<NixStorageRetainFailure>> {
        let paths = self.paths().clone();
        match self.state {
            ClaimState::Legacy { registry, owner } => {
                match registry.runtime.retain_nix_store(guard, *owner, prepared) {
                    Ok(workflow) => Ok(NixStoragePreparation {
                        destination: ReturnTo::Legacy { registry },
                        paths,
                        workflow,
                    }),
                    Err(failure) => {
                        let (guard, owner, error) = failure.into_parts();
                        Err(Box::new(NixStorageRetainFailure {
                            claim: StorageClaim {
                                state: ClaimState::Legacy {
                                    registry,
                                    owner: Box::new(owner),
                                },
                            },
                            guard,
                            error: error.into(),
                        }))
                    }
                }
            }
            ClaimState::Registered {
                registry,
                identity,
                newly_claimed,
                ..
            } => {
                let destination = ReturnTo::Registered {
                    registry: registry.clone(),
                    identity: identity.clone(),
                    newly_claimed,
                };
                match registry.retain_nix(&identity, guard, prepared) {
                    Ok(workflow) => Ok(NixStoragePreparation {
                        destination,
                        paths,
                        workflow,
                    }),
                    Err(failure) => {
                        let (guard, error) = *failure;
                        Err(Box::new(NixStorageRetainFailure {
                            claim: StorageClaim {
                                state: ClaimState::Registered {
                                    registry,
                                    identity,
                                    paths,
                                    newly_claimed,
                                },
                            },
                            guard,
                            error,
                        }))
                    }
                }
            }
        }
    }
}
impl StorageRegistry {
    fn retain_nix(
        &self,
        identity: &Arc<()>,
        guard: NixStoreGuard,
        prepared: EffectiveWorkerConfig,
    ) -> Result<NixWorkflow, Box<(NixStoreGuard, NixStorageError)>> {
        let mut entries = match self.lock(None) {
            Ok(entries) => entries,
            Err(error) => return Err(Box::new((guard, error.into()))),
        };
        let index = match selected(&entries, identity) {
            Ok(index) => index,
            Err(error) => return Err(Box::new((guard, error))),
        };
        if !entries[index].writer_checked || !matches!(entries[index].owner, EntryOwner::Direct(_))
        {
            return Err(Box::new((
                guard,
                NixStorageError::Refused("WORKER_NIX_STORAGE_RETAINED"),
            )));
        }
        let mut entry = entries.remove(index);
        let EntryOwner::Direct(owner) = entry.owner else {
            unreachable!("checked actual direct owner")
        };
        match self.runtime.retain_nix_store(guard, *owner, prepared) {
            Ok(workflow) => {
                entry.owner = EntryOwner::Nix(workflow.clone());
                entries.insert(index, entry);
                Ok(workflow)
            }
            Err(failure) => {
                let (guard, owner, error) = failure.into_parts();
                entry.owner = EntryOwner::Direct(Box::new(owner));
                entries.insert(index, entry);
                Err(Box::new((guard, error.into())))
            }
        }
    }
    fn check_nix(&self, identity: &Arc<()>, workflow: &NixWorkflow) -> Result<(), NixStorageError> {
        let entries = self.lock(self.runtime.stop_deadline())?;
        let index = selected(&entries, identity)?;
        same_workflow(&entries[index], workflow)
    }
    fn reclaim_nix(
        self: &Arc<Self>,
        identity: &Arc<()>,
        workflow: &NixWorkflow,
        newly_claimed: bool,
    ) -> Result<NixStorageReturned, NixStorageError> {
        let mut entries = self.lock(self.runtime.stop_deadline())?;
        let index = selected(&entries, identity)?;
        same_workflow(&entries[index], workflow)?;
        let returned = self
            .runtime
            .reclaim_nix_store(workflow.clone())
            .map_err(|failure| NixStorageError::from(failure.into_parts().1))?;
        let prepared_store = returned.prepared_path().map(std::path::Path::to_owned);
        let (guard, owner, outcome) = returned.into_parts();
        entries[index].owner = EntryOwner::Direct(Box::new(owner));
        Ok(NixStorageReturned {
            claim: self.handle(&entries[index], newly_claimed),
            guard,
            outcome,
            prepared_store,
        })
    }
}
fn selected(entries: &[Entry], identity: &Arc<()>) -> Result<usize, NixStorageError> {
    entries
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        .ok_or(NixStorageError::Refused("WORKER_NIX_STORAGE_CLAIM_CHANGED"))
}
fn same_workflow(entry: &Entry, workflow: &NixWorkflow) -> Result<(), NixStorageError> {
    match &entry.owner {
        EntryOwner::Nix(actual) if actual.same_workflow(workflow) => Ok(()),
        _ => Err(NixStorageError::Refused("WORKER_NIX_STORAGE_CLAIM_CHANGED")),
    }
}
