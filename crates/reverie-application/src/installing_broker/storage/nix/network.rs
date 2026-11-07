//! Actual atomic Nix-to-laptop resource ownership. No native query runs while
//! the registry lock is held; no status/path creates a replacement resource.
use super::*;
mod cold;
use reverie_contracts::worker_launch::WorkerRequest;
use reverie_host::{
    office::OfficePhone,
    worker_laptop::{LaptopError, LaptopNetworkProgress, LaptopNetworkReturned, LaptopWorkflow},
    worker_launch::ObservedCreatePlan,
};
#[derive(Debug)]
pub enum NetworkStorageError {
    Nix(NixStorageError),
    Host(LaptopError),
}
impl std::fmt::Display for NetworkStorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Nix(error) => error.fmt(f),
            Self::Host(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for NetworkStorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Nix(error) => Some(error),
            Self::Host(error) => Some(error),
        }
    }
}
struct Inputs {
    plan: ObservedCreatePlan,
    request: WorkerRequest,
    office: OfficePhone,
}
#[must_use = "retain the exact Nix preparation and supplied owners after refusal"]
pub struct NetworkStorageRetainFailure {
    preparation: NixStoragePreparation,
    inputs: Inputs,
    error: NetworkStorageError,
}
impl NetworkStorageRetainFailure {
    pub fn cause(&self) -> &NetworkStorageError {
        &self.error
    }
    pub fn into_parts(
        self: Box<Self>,
    ) -> (
        NixStoragePreparation,
        ObservedCreatePlan,
        WorkerRequest,
        OfficePhone,
        NetworkStorageError,
    ) {
        let r = self.inputs;
        (self.preparation, r.plan, r.request, r.office, self.error)
    }
}
#[must_use = "retain the actual laptop record after unknown reclamation"]
pub struct NetworkStorageReclaimFailure {
    preparation: NetworkStoragePreparation,
    error: NetworkStorageError,
}
impl NetworkStorageReclaimFailure {
    pub fn cause(&self) -> &NetworkStorageError {
        &self.error
    }
    pub fn into_parts(self: Box<Self>) -> (NetworkStoragePreparation, NetworkStorageError) {
        (self.preparation, self.error)
    }
}
/// Native networking is only one launch phase. Neither this handle nor dropping
/// it means a laptop is started, stopped or safe to release globally.
#[must_use = "retain the real registry/runtime and workflow through settlement"]
pub struct NetworkStoragePreparation {
    destination: ReturnTo,
    paths: StoragePaths,
    workflow: LaptopWorkflow,
}
impl NetworkStoragePreparation {
    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }
    pub fn run(&self, deadline: Instant) -> Result<LaptopNetworkProgress, NetworkStorageError> {
        self.check()?;
        self.destination
            .registry()
            .runtime
            .run_laptop_network(&self.workflow, deadline)
            .map_err(NetworkStorageError::Host)
    }
    fn check(&self) -> Result<(), NetworkStorageError> {
        if let ReturnTo::Registered {
            registry, identity, ..
        } = &self.destination
        {
            let entries = registry
                .lock(registry.runtime.stop_deadline())
                .map_err(NixStorageError::from)
                .map_err(NetworkStorageError::Nix)?;
            let index = selected(&entries, identity).map_err(NetworkStorageError::Nix)?;
            same_laptop(&entries[index], &self.workflow)?;
        }
        Ok(())
    }
    pub fn reclaim(self) -> Result<NetworkStorageReturned, Box<NetworkStorageReclaimFailure>> {
        let result = match &self.destination {
            ReturnTo::Legacy { registry } => reclaim_native(registry, &self.workflow)
                .map(|returned| restore_legacy(registry, returned)),
            ReturnTo::Registered {
                registry,
                identity,
                newly_claimed,
            } => reclaim_registered(registry, identity, &self.workflow, *newly_claimed),
        };
        result.map_err(|error| {
            Box::new(NetworkStorageReclaimFailure {
                preparation: self,
                error,
            })
        })
    }
}
#[must_use = "retain every restored native owner; this is not a release acknowledgement"]
pub struct NetworkStorageReturned {
    nix: NixStorageReturned,
    inputs: Inputs,
    outcome: std::result::Result<(), Arc<LaptopError>>,
}
impl NetworkStorageReturned {
    pub fn into_parts(
        self,
    ) -> (
        NixStorageReturned,
        ObservedCreatePlan,
        WorkerRequest,
        OfficePhone,
        std::result::Result<(), Arc<LaptopError>>,
    ) {
        let r = self.inputs;
        (self.nix, r.plan, r.request, r.office, self.outcome)
    }
}
impl NixStoragePreparation {
    pub fn retain_network(
        self,
        plan: ObservedCreatePlan,
        request: WorkerRequest,
        office: OfficePhone,
    ) -> Result<NetworkStoragePreparation, Box<NetworkStorageRetainFailure>> {
        self.retain_network_inputs(
            Inputs {
                plan,
                request,
                office,
            },
            None,
        )
    }
    pub fn retain_network_for_connection(
        self,
        plan: ObservedCreatePlan,
        office: OfficePhone,
        connection: &reverie_host::worker_reports::WorkerLaunchConnection,
    ) -> Result<NetworkStoragePreparation, Box<NetworkStorageRetainFailure>> {
        self.retain_network_inputs(
            Inputs {
                plan,
                request: connection.request().clone(),
                office,
            },
            Some(connection),
        )
    }
    fn retain_network_inputs(
        self,
        inputs: Inputs,
        connection: Option<&reverie_host::worker_reports::WorkerLaunchConnection>,
    ) -> Result<NetworkStoragePreparation, Box<NetworkStorageRetainFailure>> {
        match transfer(&self, inputs, connection) {
            Ok(workflow) => Ok(NetworkStoragePreparation {
                destination: self.destination,
                paths: self.paths,
                workflow,
            }),
            Err(failure) => {
                let (inputs, error) = *failure;
                Err(Box::new(NetworkStorageRetainFailure {
                    preparation: self,
                    inputs,
                    error,
                }))
            }
        }
    }
}
fn transfer(
    preparation: &NixStoragePreparation,
    inputs: Inputs,
    connection: Option<&reverie_host::worker_reports::WorkerLaunchConnection>,
) -> Result<LaptopWorkflow, Box<(Inputs, NetworkStorageError)>> {
    let ReturnTo::Registered {
        registry, identity, ..
    } = &preparation.destination
    else {
        return retain_native(
            preparation.destination.registry(),
            &preparation.workflow,
            inputs,
            connection,
        );
    };
    let mut entries = match registry.lock(registry.runtime.stop_deadline()) {
        Ok(entries) => entries,
        Err(error) => return Err(Box::new((inputs, NetworkStorageError::Nix(error.into())))),
    };
    let index = match selected(&entries, identity)
        .and_then(|index| same_workflow(&entries[index], &preparation.workflow).map(|()| index))
    {
        Ok(index) => index,
        Err(error) => return Err(Box::new((inputs, NetworkStorageError::Nix(error)))),
    };
    let workflow = retain_native(registry, &preparation.workflow, inputs, connection)?;
    entries[index].owner = EntryOwner::Laptop(workflow.clone());
    Ok(workflow)
}
fn retain_native(
    registry: &StorageRegistry,
    nix: &NixWorkflow,
    inputs: Inputs,
    connection: Option<&reverie_host::worker_reports::WorkerLaunchConnection>,
) -> Result<LaptopWorkflow, Box<(Inputs, NetworkStorageError)>> {
    let result = match connection {
        Some(connection) => registry.runtime.retain_laptop_network_for_connection(
            nix,
            inputs.plan,
            inputs.office,
            connection,
        ),
        None => {
            registry
                .runtime
                .retain_laptop_network(nix, inputs.plan, inputs.request, inputs.office)
        }
    };
    result.map_err(|failure| {
        let (plan, request, office, error) = failure.into_parts();
        Box::new((
            Inputs {
                plan,
                request,
                office,
            },
            NetworkStorageError::Host(error),
        ))
    })
}
fn reclaim_native(
    registry: &StorageRegistry,
    workflow: &LaptopWorkflow,
) -> Result<LaptopNetworkReturned, NetworkStorageError> {
    registry
        .runtime
        .reclaim_laptop_network(workflow.clone())
        .map_err(|failure| NetworkStorageError::Host(failure.into_parts().1))
}
fn same_laptop(entry: &Entry, workflow: &LaptopWorkflow) -> Result<(), NetworkStorageError> {
    if matches!(&entry.owner,EntryOwner::Laptop(actual) if actual.same_workflow(workflow)) {
        Ok(())
    } else {
        Err(NetworkStorageError::Nix(NixStorageError::Refused(
            "WORKER_LAPTOP_STORAGE_CLAIM_CHANGED",
        )))
    }
}
fn restore_legacy(
    registry: &Arc<StorageRegistry>,
    returned: LaptopNetworkReturned,
) -> NetworkStorageReturned {
    let (nix, plan, request, office, outcome) = returned.into_parts();
    let prepared_store = nix.prepared_path().map(std::path::Path::to_owned);
    let (guard, owner, nix_outcome) = nix.into_parts();
    let claim = StorageClaim {
        state: ClaimState::Legacy {
            registry: registry.clone(),
            owner: Box::new(owner),
        },
    };
    NetworkStorageReturned {
        nix: NixStorageReturned {
            claim,
            guard,
            outcome: nix_outcome,
            prepared_store,
        },
        inputs: Inputs {
            plan,
            request,
            office,
        },
        outcome,
    }
}
fn reclaim_registered(
    registry: &Arc<StorageRegistry>,
    identity: &Arc<()>,
    workflow: &LaptopWorkflow,
    newly_claimed: bool,
) -> Result<NetworkStorageReturned, NetworkStorageError> {
    let mut entries = registry
        .lock(registry.runtime.stop_deadline())
        .map_err(NixStorageError::from)
        .map_err(NetworkStorageError::Nix)?;
    let index = selected(&entries, identity).map_err(NetworkStorageError::Nix)?;
    same_laptop(&entries[index], workflow)?;
    let returned = reclaim_native(registry, workflow)?;
    let (nix, plan, request, office, outcome) = returned.into_parts();
    let prepared_store = nix.prepared_path().map(std::path::Path::to_owned);
    let (guard, owner, nix_outcome) = nix.into_parts();
    entries[index].owner = EntryOwner::Direct(Box::new(owner));
    Ok(NetworkStorageReturned {
        nix: NixStorageReturned {
            claim: registry.handle(&entries[index], newly_claimed),
            guard,
            outcome: nix_outcome,
            prepared_store,
        },
        inputs: Inputs {
            plan,
            request,
            office,
        },
        outcome,
    })
}
