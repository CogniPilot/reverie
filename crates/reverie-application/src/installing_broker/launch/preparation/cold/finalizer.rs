//! Resource-specific ordinary finally. Shared lifecycle/socket/Hold sequencing
//! belongs to preparation::finalization; no receipt or local close grants it.
use super::*;
use reverie_host::worker_laptop::{CreatedCleanup, StoppedCreatedLaptop};
mod resources;

enum Owner<'a> {
    Body(Box<ColdBody<'a>>),
    Closed(AllocationClosedCold<'a>),
    Viewing(ViewingCold<'a>),
}
struct Finalizer<'a> {
    owner: Owner<'a>,
    primary: Option<ColdError>,
    body_causes: Vec<ColdError>,
    errors: Vec<ColdError>,
    completed: Option<bool>,
    stopped: Option<StoppedCreatedLaptop>,
}
impl<'a> Owner<'a> {
    fn scope(&self) -> &ColdScope<'a> {
        match self {
            Self::Body(owner) => &owner.scope,
            Self::Closed(owner) => &owner.scope,
            Self::Viewing(owner) => &owner.owner.scope,
        }
    }
    fn scope_mut(&mut self) -> &mut ColdScope<'a> {
        match self {
            Self::Body(owner) => &mut owner.scope,
            Self::Closed(owner) => &mut owner.scope,
            Self::Viewing(owner) => &mut owner.owner.scope,
        }
    }
    fn started(&self) -> Option<&Arc<StartedLaptop>> {
        match self {
            Self::Body(owner) => owner.started.as_ref(),
            Self::Closed(owner) => Some(&owner.started),
            Self::Viewing(owner) => Some(&owner.owner.started),
        }
    }
    fn created(&self) -> Option<&CreatedLaptop> {
        match self {
            Self::Body(owner) => owner
                .creation
                .as_ref()
                .map(|owner| &owner.created)
                .or_else(|| owner.started.as_ref().map(|owner| &owner.created)),
            Self::Closed(owner) => Some(&owner.started.created),
            Self::Viewing(owner) => Some(&owner.owner.started.created),
        }
    }
    fn network(&self) -> Option<Arc<storage::NetworkStoragePreparation>> {
        if let Some(started) = self.started() {
            return Some(started.network.clone());
        }
        match self {
            Self::Body(owner) => match &owner.resources {
                Some(Resources::NetworkHeld(network) | Resources::Network(network)) => {
                    Some(network.clone())
                }
                _ => None,
            },
            _ => None,
        }
    }
    fn remove_registration(&self, completed: bool) -> bool {
        let cli_started = self.started().is_some()
            || matches!(self, Self::Body(owner) if owner.creation.as_ref().is_some_and(|creation| creation.pane.is_some()));
        (!cli_started && !matches!(self.scope().original, OriginalRuntime::Running))
            || completed
    }
    fn stop_required(&self, completed: bool) -> bool {
        let scope = self.scope();
        let owned = self.created().is_some() || !matches!(scope.original, OriginalRuntime::Absent);
        owned
            && !matches!(scope.budget, CreationBudget::ReplacementPending)
            && self.remove_registration(completed)
    }
}
impl Finalizer<'_> {
    fn close_allocation(&mut self) {
        if let Owner::Body(owner) = &mut self.owner {
            drop(owner.lifecycle.take());
            if owner.allocation_unconfirmed {
                self.errors
                    .push(ColdError::Refused("RESOURCE_ADMISSION_RELEASE_UNCONFIRMED"));
            }
        }
        if let Some(admission) = self.owner.scope_mut().preparing.admitted.admission.take()
            && let Err(error) = admission.close()
        {
            self.errors.push(error.into());
        }
    }
    fn observe_receipt(&mut self) {
        let observed = match (self.owner.created(), self.owner.network()) {
            (Some(created), Some(network)) => {
                network.created_completed(created).map_err(Into::into)
            }
            _ => self
                .owner
                .scope()
                .receipt
                .as_ref()
                .map_or(Ok(false), |receipt| {
                    receipt
                        .recheck_is_file(&self.owner.scope().preparing.broker().storage.runtime)
                        .map_err(StorageWorkflowError::from)
                        .map_err(Into::into)
                }),
        };
        match observed {
            Ok(completed) => self.completed = Some(completed),
            Err(error) => self.errors.push(error),
        }
    }
    fn stop_created(&mut self) {
        let Some(completed) = self.completed else {
            return;
        };
        if !self.owner.stop_required(completed) {
            return;
        }
        let (Some(created), Some(network)) = (self.owner.created(), self.owner.network()) else {
            // Before create, the resource-specific original-target branch is
            // handled separately; no Created token is manufactured here.
            return;
        };
        let target = match network.created_target(created) {
            Ok(target) => target,
            Err(error) => {
                self.errors.push(error.into());
                return;
            }
        };
        let broker = self.owner.scope().preparing.broker();
        let admission = match broker.admit_ordinary_stop(&target) {
            Ok(admission) => admission,
            Err(error) => {
                self.errors.push(error.into());
                return;
            }
        };
        let stopped = network.stop_created_under_admission(
            created,
            &self.owner.scope().preparing.admitted.request.connection,
            &admission,
            broker,
        );
        let closed = if stopped.is_ok() {
            admission.close()
        } else {
            admission.abort()
        };
        match stopped {
            Ok(CreatedCleanup::Stopped(stopped)) => self.stopped = Some(stopped),
            Ok(CreatedCleanup::Retained) => self.errors.push(ColdBody::phase_refused(
                &network,
                "WORKER_CREATED_STOP_RETAINED",
            )),
            Err(error) => self.errors.push(error.into()),
        }
        if let Err(error) = closed {
            self.errors.push(error.into());
        }
    }
    fn close_viewer(&mut self, budget: super::super::finalization::CleanupBudget) {
        let (Some(created), Some(network)) = (self.owner.created(), self.owner.network()) else {
            return;
        };
        // Mint the source TERM/KILL observation window only AFTER actual stop.
        if let Err(error) = network.close_created_viewer(created, budget.phase(5_100)) {
            self.errors.push(error.into());
        }
    }
}
