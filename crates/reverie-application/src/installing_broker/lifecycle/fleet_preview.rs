//! Original lifecycle/Office allocations observed without taking registrations.
use super::*;

struct Registered {
    session: ProfileSessionId,
    name: WorkerContainerName,
    office: Arc<recovered::RecoveredOffice>,
    started: Option<Arc<launch::StartedLaptop>>,
    paths: reverie_store::storage_identity::StoragePaths,
}
pub(in crate::installing_broker) struct FleetRegistrationSnapshot<'a> {
    owner: &'a InstalledWorker,
    generation: LaunchGeneration,
    registered: Vec<Registered>,
    active: Vec<(ProfileSessionId, Arc<()>)>,
    pending: Vec<(ProfileSessionId, WorkerContainerName, Arc<()>)>,
}
impl InstalledWorker {
    pub(in crate::installing_broker) fn capture_fleet_preview(
        &self,
    ) -> Result<FleetRegistrationSnapshot<'_>, GateError> {
        let lifecycle = self.try_supervisor_lifecycle()?.ok_or_else(unavailable)?;
        if lifecycle.guard.draining {
            return Err(unavailable());
        }
        let registered = lifecycle
            .guard
            .iter()
            .map(|entry| {
                let (office, started, paths) = match &entry.owner {
                    LaptopOwner::Recovered(owner) => (
                        Arc::clone(&owner.office),
                        None,
                        owner.storage.paths().clone(),
                    ),
                    LaptopOwner::Started(owner) => (
                        Arc::clone(&owner.office),
                        Some(Arc::clone(owner)),
                        owner.network.paths().clone(),
                    ),
                    #[cfg(test)]
                    LaptopOwner::Modeled => return Err(unavailable()),
                };
                Ok(Registered {
                    session: entry.session.clone(),
                    name: entry.name.clone(),
                    office,
                    started,
                    paths,
                })
            })
            .collect::<Result<Vec<_>, GateError>>()?;
        Ok(FleetRegistrationSnapshot {
            owner: self,
            generation: lifecycle.guard.generation.clone(),
            registered,
            active: lifecycle
                .guard
                .active
                .iter()
                .map(|entry| (entry.session.clone(), Arc::clone(&entry.identity)))
                .collect(),
            pending: lifecycle
                .guard
                .pending
                .iter()
                .map(|entry| {
                    (
                        entry.session.clone(),
                        entry.name.clone(),
                        Arc::clone(&entry.identity),
                    )
                })
                .collect(),
        })
    }
}
impl FleetRegistrationSnapshot<'_> {
    pub(in crate::installing_broker) fn registered_names(&self) -> Vec<WorkerContainerName> {
        self.registered
            .iter()
            .map(|entry| entry.name.clone())
            .collect()
    }
    pub(in crate::installing_broker) fn paths_for_session(
        &self,
        session: &ProfileSessionId,
    ) -> Option<&reverie_store::storage_identity::StoragePaths> {
        self.registered
            .iter()
            .find(|entry| &entry.session == session)
            .map(|entry| &entry.paths)
    }
    pub(in crate::installing_broker) fn data(&self) -> serde_json::Value {
        serde_json::json!({"generation":self.generation.serial().as_str(),
            "registered":self.registered.iter().map(|entry|serde_json::json!({"session":entry.session.as_str(),"name":entry.name.as_str(),"kind":if entry.started.is_some(){"started"}else{"recovered"}})).collect::<Vec<_>>(),
            "active":self.active.iter().map(|(sid,_)|sid.as_str()).collect::<Vec<_>>(),
            "pending":self.pending.iter().map(|(sid,name,_)|(sid.as_str(),name.as_str())).collect::<Vec<_>>()})
    }
    pub(in crate::installing_broker) fn assert_current(
        &self,
        owner: &InstalledWorker,
    ) -> Result<(), GateError> {
        if !std::ptr::eq(self.owner, owner) {
            return Err(unavailable());
        }
        let lifecycle = owner.try_supervisor_lifecycle()?.ok_or_else(unavailable)?;
        lifecycle.check_generation(&self.generation)?;
        if lifecycle.guard.len() != self.registered.len()
            || lifecycle.guard.active.len() != self.active.len()
            || lifecycle.guard.pending.len() != self.pending.len()
        {
            return Err(unavailable());
        }
        for (observed, current) in self.registered.iter().zip(lifecycle.guard.iter()) {
            if observed.session != current.session || observed.name != current.name {
                return Err(unavailable());
            }
            let matches = match (&observed.started, &current.owner) {
                (Some(before), LaptopOwner::Started(current)) => Arc::ptr_eq(before, current),
                (None, LaptopOwner::Recovered(current)) => {
                    Arc::ptr_eq(&observed.office, &current.office)
                }
                _ => false,
            };
            if !matches {
                return Err(unavailable());
            }
        }
        for ((sid, identity), entry) in self.active.iter().zip(&lifecycle.guard.active) {
            if sid != &entry.session || !Arc::ptr_eq(identity, &entry.identity) {
                return Err(unavailable());
            }
        }
        for ((sid, name, identity), entry) in self.pending.iter().zip(&lifecycle.guard.pending) {
            if sid != &entry.session
                || name != &entry.name
                || !Arc::ptr_eq(identity, &entry.identity)
            {
                return Err(unavailable());
            }
        }
        Ok(())
    }
}
fn unavailable() -> GateError {
    GateError::Refused("FLEET_PREVIEW_LIFECYCLE_UNAVAILABLE")
}
