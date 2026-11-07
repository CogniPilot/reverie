//! Actual undispatched return under the existing destination registry lock.
//! No result or permission is manufactured for a network command never run.
use super::*;
use reverie_host::worker_reports::WorkerLaunchConnection;

impl NetworkStoragePreparation {
    pub(in crate::installing_broker) fn abort_held_network(
        &self,
        connection: &WorkerLaunchConnection,
    ) -> Result<
        (
            NixStorageReturned,
            ObservedCreatePlan,
            WorkerRequest,
            OfficePhone,
        ),
        NetworkStorageError,
    > {
        let registry = self.destination.registry();
        if let ReturnTo::Registered {
            identity,
            newly_claimed,
            ..
        } = &self.destination
        {
            let mut entries = registry
                .lock(registry.runtime.stop_deadline())
                .map_err(NixStorageError::from)
                .map_err(NetworkStorageError::Nix)?;
            let index = selected(&entries, identity).map_err(NetworkStorageError::Nix)?;
            same_laptop(&entries[index], &self.workflow)?;
            // All fallible App publication checks precede the guard's take.
            let originals = registry
                .runtime
                .abort_held_laptop_network(&self.workflow, connection)
                .map_err(NetworkStorageError::Host)?;
            let (nix, plan, request, office) = originals.into_parts();
            let prepared_store = nix.prepared_path().map(std::path::Path::to_owned);
            let (guard, storage, outcome) = nix.into_parts();
            entries[index].owner = EntryOwner::Direct(Box::new(storage));
            return Ok((
                NixStorageReturned {
                    claim: registry.handle(&entries[index], *newly_claimed),
                    guard,
                    outcome,
                    prepared_store,
                },
                plan,
                request,
                office,
            ));
        }
        let originals = registry
            .runtime
            .abort_held_laptop_network(&self.workflow, connection)
            .map_err(NetworkStorageError::Host)?;
        let (nix, plan, request, office) = originals.into_parts();
        let prepared_store = nix.prepared_path().map(std::path::Path::to_owned);
        let (guard, storage, outcome) = nix.into_parts();
        Ok((
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
            },
            plan,
            request,
            office,
        ))
    }
}
