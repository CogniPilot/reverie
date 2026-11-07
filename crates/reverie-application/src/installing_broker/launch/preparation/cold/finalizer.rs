//! Resource-specific ordinary finally. Shared lifecycle/socket/Hold sequencing
//! belongs to preparation::finalization; no receipt or local close grants it.
use super::*;
use crate::installing_broker::launch::preparation::finalization::CleanupBudget;
use reverie_host::worker_laptop::{CreatedCleanup, StoppedCreatedLaptop};
mod created;
mod direct;
mod entry;
mod original;
mod prefix;
mod preparation_failure;
mod registration;
mod resources;

enum Owner<'a> {
    Body(Box<ColdBody<'a>>),
    Closed(AllocationClosedCold<'a>),
    Viewing(ViewingCold<'a>),
    Classified(Box<ClassifiedCleanup<'a>>),
    Preparation(Box<PreparationFailure<'a>>),
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
    original_remainder: Option<FinalStorageRemainder>,
    returned: Option<Resources>,
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
impl<'a> ColdFinalizationFailure<'a> {
    pub(super) fn retained_preparation(owner: Box<PreparationFailure<'a>>) -> Box<Self> {
        Box::new(Self {
            cleanup: Finalizer {
                owner: Owner::Preparation(owner),
                primary: None,
                body_causes: Vec::new(),
                errors: vec![ColdError::Refused("WORKER_PREPARATION_RESOURCE_RETAINED")],
                completed: None,
                stopped: None,
                target: None,
                original_remainder: None,
                returned: None,
            },
        })
    }
    pub fn request(&self) -> &WorkerRequest {
        match &self.cleanup.owner {
            Owner::Preparation(owner) => owner.preparing.admitted.request(),
            owner => owner.scope().preparing.admitted.request(),
        }
    }
    pub fn cleanup_error_count(&self) -> usize {
        self.cleanup.errors.len()
            + match &self.cleanup.owner {
                Owner::Preparation(owner) => owner.cleanup.len(),
                _ => 0,
            }
    }
}
impl std::fmt::Debug for ColdFinalizationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Owner::Preparation(owner) = &self.cleanup.owner {
            return owner.fmt(out);
        }
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
        if let Owner::Preparation(owner) = &self.cleanup.owner {
            return owner.fmt(out);
        }
        if let Some(primary) = &self.cleanup.primary {
            write!(out, "{primary}; ")?;
        }
        for error in self.cleanup.body_causes.iter().chain(&self.cleanup.errors) {
            write!(out, "{error}; ")?;
        }
        match self.cleanup.resource() {
            Some(Resources::FinalStorageFailed { failure, .. }) => {
                write!(out, "{}; ", failure.cause())?
            }
            Some(Resources::CreatedReturnFailed(failure)) => write!(out, "{failure:?}; ")?,
            Some(Resources::Finalized { plan, retained, .. }) => write!(
                out,
                "storage disposition for {}: retained={retained}; ",
                plan.session(),
            )?,
            _ => {}
        }
        Ok(())
    }
}
impl std::error::Error for ColdFinalizationFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        if let Owner::Preparation(owner) = &self.cleanup.owner {
            return Some(owner.as_ref().cause());
        }
        if let Some(primary) = &self.cleanup.primary {
            return Some(primary);
        }
        match self.cleanup.resource() {
            Some(Resources::CreatedReturnFailed(failure)) => Some(failure.cause()),
            Some(Resources::FinalStorageFailed { failure, .. }) => Some(failure.cause()),
            _ => self
                .cleanup
                .errors
                .first()
                .map(|cause| cause as &dyn std::error::Error),
        }
    }
}
impl<'a> Owner<'a> {
    fn scope(&self) -> &ColdScope<'a> {
        match self {
            Self::Body(owner) => &owner.scope,
            Self::Closed(owner) => &owner.scope,
            Self::Viewing(owner) => &owner.owner.scope,
            Self::Classified(owner) => &owner.scope,
            Self::Preparation(_) => {
                unreachable!("retained early failure has no fabricated Cold scope")
            }
        }
    }
    fn scope_mut(&mut self) -> &mut ColdScope<'a> {
        match self {
            Self::Body(owner) => &mut owner.scope,
            Self::Closed(owner) => &mut owner.scope,
            Self::Viewing(owner) => &mut owner.owner.scope,
            Self::Classified(owner) => &mut owner.scope,
            Self::Preparation(_) => {
                unreachable!("retained early failure has no fabricated Cold scope")
            }
        }
    }
    fn started(&self) -> Option<&Arc<StartedLaptop>> {
        match self {
            Self::Body(owner) => owner.started.as_ref(),
            Self::Closed(owner) => Some(&owner.started),
            Self::Viewing(owner) => Some(&owner.owner.started),
            Self::Classified(_) | Self::Preparation(_) => None,
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
            Self::Classified(_) | Self::Preparation(_) => None,
        }
    }
    fn resource_slot(&mut self) -> Option<&mut Option<Resources>> {
        match self {
            Self::Body(owner) => Some(&mut owner.resources),
            Self::Classified(owner) => Some(&mut owner.resources),
            Self::Closed(_) | Self::Viewing(_) | Self::Preparation(_) => None,
        }
    }
    fn resource(&self) -> Option<&Resources> {
        match self {
            Self::Body(owner) => owner.resources.as_ref(),
            Self::Classified(owner) => owner.resources.as_ref(),
            Self::Closed(_) | Self::Viewing(_) | Self::Preparation(_) => None,
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
            && !matches!(
                scope.budget,
                CreationBudget::Unconfirmed | CreationBudget::ReplacementPending
            )
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
        original_remainder: None,
        returned: None,
    };
    // The actual original allocation finally precedes outstanding Nix close.
    cleanup.close_allocation();
    cleanup.close_guard();
    // Known Held/ready network returns publish the original plan here. Read
    // that same restored owner before selecting its fixed stop target.
    cleanup.capture_target();
    cleanup.observe_receipt();
    cleanup.stop_created();
    cleanup.stop_classified_original(budget);
    cleanup.stop_returned_original(budget);
    cleanup.close_viewer(budget);
    cleanup.cleanup_request();
    cleanup.metadata(budget);
    let observation = cleanup.observe_storage();
    if let Some(observation) = &observation {
        cleanup.close_direct_offices(observation.is_live(), budget);
    }
    let mut storage_retained = false;
    if cleanup.errors.is_empty() {
        if let Some(observation) = observation {
            storage_retained = cleanup.finish_storage(observation, budget).unwrap_or(false);
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
    fn resource(&self) -> Option<&Resources> {
        self.returned.as_ref().or_else(|| self.owner.resource())
    }
    fn capture_target(&mut self) {
        let plan = match self.owner.resource() {
            Some(
                Resources::OriginalCleanup { plan, .. } | Resources::UnobservedCleanup { plan, .. },
            ) => Some(plan),
            Some(Resources::Direct(input)) => Some(&input.plan),
            Some(Resources::Stopped(input)) => Some(&input.plan),
            Some(Resources::PreparingNix(input)) => Some(&input.stopped.plan),
            Some(Resources::CopyingNix(input)) => Some(&input.plan),
            Some(Resources::Returned(input)) => Some(&input.plan),
            _ => None,
        };
        if let Some(plan) = plan {
            // Preserve the original one-time argument/configuration pairing.
            // This read-side assertion supplies no stop or release authority.
            if reverie_contracts::worker_config::encode_config(plan.source())
                != reverie_contracts::worker_config::encode_config(
                    self.owner.scope().current.configuration(),
                )
            {
                self.errors
                    .push(ColdError::Refused("WORKER_COLD_PLAN_SOURCE_CHANGED"));
                return;
            }
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
        let closed = match budget {
            CleanupBudget::Bounded(end) => network.close_created_viewer(created, end),
            CleanupBudget::Worker => network.close_created_viewer_for_worker(created),
        };
        if let Err(error) = closed {
            self.errors.push(error.into());
        }
    }
    fn cleanup_request(&mut self) {
        let (Some(created), Some(network)) = (self.owner.created(), self.owner.network()) else {
            return;
        };
        // The actual retained publication chooses whether source started was
        // reached; no caller bool, nonce or filesystem path selects deletion.
        if let Err(error) = network.cleanup_created_request(created) {
            self.errors.push(error.into());
        }
    }
}
