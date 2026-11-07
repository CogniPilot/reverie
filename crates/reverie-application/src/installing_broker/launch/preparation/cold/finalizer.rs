//! Resource-specific ordinary finally. Shared lifecycle/socket/Hold sequencing
//! belongs to preparation::finalization; no receipt or local close grants it.
use super::*;
use crate::installing_broker::launch::preparation::finalization::CleanupBudget;
use reverie_host::worker_laptop::{CreatedCleanup, StoppedCreatedLaptop};
mod direct;
mod entry;
mod original;
mod prefix;
mod registration;
mod resources;

enum Owner<'a> {
    Body(Box<ColdBody<'a>>),
    Closed(AllocationClosedCold<'a>),
    Viewing(ViewingCold<'a>),
    Classified(Box<ClassifiedCleanup<'a>>),
}
struct ClassifiedCleanup<'a> {
    scope: ColdScope<'a>,
    lifecycle: Option<LaptopLifecycle<'a>>,
    resources: Option<Resources>,
}
struct Finalizer<'a> {
    owner: Owner<'a>,
    primary: Option<ColdError>,
    body_causes: Vec<ColdError>,
    errors: Vec<ColdError>,
    completed: Option<bool>,
    stopped: Option<StoppedCreatedLaptop>,
    target: Option<WorkerContainerName>,
}
#[must_use = "retains the original resource phases and counted handler hold"]
pub struct ColdFinalizationFailure<'a> {
    cleanup: Finalizer<'a>,
}
/// Only this handler's checked resource disposition and transport finalizers.
/// It provides no Company/global stop or capacity acknowledgement.
#[derive(Debug)]
pub struct ColdHandlerClosed {
    completed: bool,
    storage_retained: bool,
    primary: Option<ColdError>,
    body_causes: Vec<ColdError>,
}
impl ColdHandlerClosed {
    pub fn completed(&self) -> bool {
        self.completed
    }
    pub fn storage_retained(&self) -> bool {
        self.storage_retained
    }
    pub fn primary_error(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.primary
            .as_ref()
            .map(|cause| cause as &dyn std::error::Error)
            .or_else(|| {
                self.body_causes
                    .first()
                    .map(|cause| cause as &dyn std::error::Error)
            })
    }
}
impl ColdFinalizationFailure<'_> {
    pub fn request(&self) -> &WorkerRequest {
        self.cleanup.owner.scope().preparing.admitted.request()
    }
    pub fn cleanup_error_count(&self) -> usize {
        self.cleanup.errors.len()
    }
}
impl std::fmt::Debug for ColdFinalizationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("ColdFinalizationFailure")
            .field("session", self.request().session())
            .field("primary", &self.cleanup.primary)
            .field("body_causes", &self.cleanup.body_causes)
            .field("cleanup", &self.cleanup.errors)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for ColdFinalizationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(primary) = &self.cleanup.primary {
            write!(out, "{primary}; ")?;
        }
        for error in self.cleanup.body_causes.iter().chain(&self.cleanup.errors) {
            write!(out, "{error}; ")?;
        }
        Ok(())
    }
}
impl std::error::Error for ColdFinalizationFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cleanup
            .primary
            .as_ref()
            .or(self.cleanup.errors.first())
            .map(|cause| cause as &dyn std::error::Error)
    }
}
impl<'a> Owner<'a> {
    fn scope(&self) -> &ColdScope<'a> {
        match self {
            Self::Body(owner) => &owner.scope,
            Self::Closed(owner) => &owner.scope,
            Self::Viewing(owner) => &owner.owner.scope,
            Self::Classified(owner) => &owner.scope,
        }
    }
    fn scope_mut(&mut self) -> &mut ColdScope<'a> {
        match self {
            Self::Body(owner) => &mut owner.scope,
            Self::Closed(owner) => &mut owner.scope,
            Self::Viewing(owner) => &mut owner.owner.scope,
            Self::Classified(owner) => &mut owner.scope,
        }
    }
    fn started(&self) -> Option<&Arc<StartedLaptop>> {
        match self {
            Self::Body(owner) => owner.started.as_ref(),
            Self::Closed(owner) => Some(&owner.started),
            Self::Viewing(owner) => Some(&owner.owner.started),
            Self::Classified(_) => None,
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
            Self::Classified(_) => None,
        }
    }
    fn resource_slot(&mut self) -> Option<&mut Option<Resources>> {
        match self {
            Self::Body(owner) => Some(&mut owner.resources),
            Self::Classified(owner) => Some(&mut owner.resources),
            Self::Closed(_) | Self::Viewing(_) => None,
        }
    }
    fn resource(&self) -> Option<&Resources> {
        match self {
            Self::Body(owner) => owner.resources.as_ref(),
            Self::Classified(owner) => owner.resources.as_ref(),
            Self::Closed(_) | Self::Viewing(_) => None,
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
        (!cli_started && !matches!(self.scope().original, OriginalRuntime::Running)) || completed
    }
    fn stop_required(&self, completed: bool) -> bool {
        let scope = self.scope();
        let owned = self.created().is_some() || !matches!(scope.original, OriginalRuntime::Absent);
        owned
            && !matches!(scope.budget, CreationBudget::ReplacementPending)
            && self.remove_registration(completed)
    }
}
fn finish<'a>(
    owner: Owner<'a>,
    primary: Option<ColdError>,
    budget: CleanupBudget,
) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
    let mut cleanup = Finalizer {
        owner,
        primary,
        body_causes: Vec::new(),
        errors: Vec::new(),
        completed: None,
        stopped: None,
        target: None,
    };
    // The actual original allocation finally precedes outstanding Nix close.
    cleanup.close_allocation();
    cleanup.capture_target();
    cleanup.close_guard();
    cleanup.observe_receipt();
    cleanup.stop_created();
    cleanup.stop_classified_original(budget);
    cleanup.close_viewer(budget);
    cleanup.metadata(budget);
    let observation = cleanup.observe_direct_storage();
    if let Some(observation) = &observation {
        cleanup.close_direct_offices(observation.is_live(), budget);
    }
    let mut storage_retained = false;
    if cleanup.errors.is_empty() {
        if let Some(observation) = observation {
            storage_retained = cleanup
                .finish_direct_storage(&observation, budget.phase(20_000))
                .unwrap_or(false);
        } else {
            cleanup
                .errors
                .push(ColdError::Refused("WORKER_COLD_RESOURCE_RETAINED"));
        }
    }
    let scope = cleanup.owner.scope();
    if let Err(error) = budget.close_request(&scope.preparing.admitted.request) {
        cleanup.errors.push(error.into());
    }
    if cleanup.errors.is_empty()
        && let Some(token) = &mut cleanup.owner.scope_mut().active
        && let Err(error) = budget.release_hold(token)
    {
        cleanup.errors.push(error.into());
    }
    if cleanup.errors.is_empty() {
        Ok(ColdHandlerClosed {
            completed: cleanup.completed.expect("fresh receipt observation"),
            storage_retained,
            primary: cleanup.primary,
            body_causes: cleanup.body_causes,
        })
    } else {
        Err(Box::new(ColdFinalizationFailure { cleanup }))
    }
}
impl Finalizer<'_> {
    fn capture_target(&mut self) {
        let plan = match self.owner.resource() {
            Some(Resources::OriginalCleanup { plan, .. }) => Some(plan),
            Some(Resources::Direct(input)) => Some(&input.plan),
            Some(Resources::Stopped(input)) => Some(&input.plan),
            Some(Resources::PreparingNix(input)) => Some(&input.stopped.plan),
            Some(Resources::CopyingNix(input)) => Some(&input.plan),
            Some(Resources::Returned(input)) => Some(&input.plan),
            _ => None,
        };
        if let Some(plan) = plan {
            self.target = Some(WorkerContainerName::from_launch_name_data(
                plan.arguments().worker_name(),
            ));
        }
    }
    fn close_allocation(&mut self) {
        if let Owner::Body(owner) = &mut self.owner {
            drop(owner.lifecycle.take());
            if owner.allocation_unconfirmed {
                self.errors
                    .push(ColdError::Refused("RESOURCE_ADMISSION_RELEASE_UNCONFIRMED"));
            }
        }
        if let Owner::Classified(owner) = &mut self.owner {
            drop(owner.lifecycle.take());
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
        self.target = Some(target.clone());
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
