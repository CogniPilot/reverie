use super::*;
use reverie_application::installing_broker::{
    OfflineActorSetupError, OfflineImageInspectionFailure,
};
use reverie_host::worker_service::{StoppedServiceFailure, WorkerServiceError};
pub enum InitialWebsiteRolloutError<'a> {
    Refused(&'static str),
    Deployment(DeploymentError),
    Quiesce(DeploymentServiceQuiesceFailure),
    Maintenance(Box<StoppedServiceFailure>),
    Actor(Box<OfflineActorSetupFailure<'a>>),
    ActorComponent(OfflineActorSetupError<'a>),
    Inspection(Box<OfflineImageInspectionFailure<'a>>),
    Service(WorkerServiceError),
    Gate(GateError),
    Validation(WorkerValidationError),
    Data(ResourceActorDataError),
    Inventory(reverie_contracts::reservation_engine::EngineDataError),
    Bootstrap(ResourceFactsError),
    Input(reverie_host::website_facts::WebsiteFactsError),
    FixedReference(std::io::Error),
}
impl InitialWebsiteRolloutError<'_> {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Deployment(cause) => cause.code(),
            Self::Quiesce(DeploymentServiceQuiesceFailure::Stop(cause)) => {
                cause.primary_error().code()
            }
            Self::Quiesce(DeploymentServiceQuiesceFailure::Maintenance(cause))
            | Self::Maintenance(cause) => cause.primary_error().code(),
            Self::Actor(cause) => cause.cause().code(),
            Self::ActorComponent(cause) => cause.code(),
            Self::Inspection(cause) => cause.cause().code(),
            Self::Service(cause) => cause.code(),
            Self::Gate(cause) => cause.code(),
            Self::Validation(cause) => cause.code(),
            Self::Data(cause) => cause.code(),
            Self::Inventory(cause) => cause.code(),
            Self::Bootstrap(cause) => cause.code(),
            Self::Input(cause) => cause.code(),
            Self::FixedReference(_) => "INITIAL_WEBSITE_FIXED_PROVENANCE_UNAVAILABLE",
        }
    }
}
impl std::fmt::Debug for InitialWebsiteRolloutError<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("InitialWebsiteRolloutError")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for InitialWebsiteRolloutError<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for InitialWebsiteRolloutError<'_> {}
pub struct InitialWebsiteRolloutFailure<'a> {
    owner: Option<Box<Owner<'a>>>,
    cause: Option<InitialWebsiteRolloutError<'a>>,
    cleanup: Vec<InitialWebsiteRolloutError<'a>>,
    close_attempted: bool,
}
impl<'a> InitialWebsiteRolloutFailure<'a> {
    pub(super) fn new(owner: Box<Owner<'a>>, cause: InitialWebsiteRolloutError<'a>) -> Box<Self> {
        let mut failure = Box::new(Self {
            owner: Some(owner),
            cause: Some(cause),
            cleanup: Vec::new(),
            close_attempted: false,
        });
        failure.close_components();
        failure
    }
    pub fn cause(&self) -> &InitialWebsiteRolloutError<'a> {
        self.cause.as_ref().expect("same retained first cause")
    }
    pub fn cleanup_errors(&self) -> &[InitialWebsiteRolloutError<'a>] {
        &self.cleanup
    }
    pub fn deployment_operation(&self) -> Option<&str> {
        self.owner
            .as_ref()
            .and_then(|owner| owner.preview.as_ref())
            .map(|preview| preview.operation.as_str())
    }
    pub fn operation_id(&self) -> Option<&str> {
        self.owner
            .as_ref()
            .and_then(|owner| owner.operation.as_ref())
            .map(JournalId::as_str)
    }
    /// Settle original components only; no retry, start, rollback, marker clear,
    /// adoption or service-fence release is performed by failure finalization.
    pub fn close_components(&mut self) {
        if self.close_attempted {
            return;
        }
        self.close_attempted = true;
        match self.cause.as_mut().expect("same retained first cause") {
            InitialWebsiteRolloutError::Quiesce(cause) => {
                if let Err(cause) = cause.close_components() {
                    self.cleanup
                        .push(InitialWebsiteRolloutError::Service(cause));
                }
            }
            InitialWebsiteRolloutError::Actor(cause) => {
                if let Err(cause) = cause.close_components() {
                    self.cleanup
                        .push(InitialWebsiteRolloutError::ActorComponent(cause));
                }
            }
            InitialWebsiteRolloutError::Maintenance(cause) => {
                if let Err(cause) = cause.close_components() {
                    self.cleanup
                        .push(InitialWebsiteRolloutError::Service(cause));
                }
            }
            _ => {}
        }
        if let Some(owner) = &mut self.owner {
            owner.close_components(&mut self.cleanup);
        }
    }
}
impl<'a> Owner<'a> {
    fn close_components(&mut self, errors: &mut Vec<InitialWebsiteRolloutError<'a>>) {
        if let Err(cause) = self.input.assert_finalized() {
            errors.push(InitialWebsiteRolloutError::Input(cause));
        }
        if let Some(actor) = self.actor.take()
            && let Err(cause) = actor.close(self.end)
        {
            errors.push(InitialWebsiteRolloutError::Actor(cause));
        }
        if let Err(cause) = self.close_deployment() {
            errors.push(cause);
        }
        if !self.actor_attempted
            && let Err(cause) = self.broker.close_offline_image_inspection(self.end)
        {
            errors.push(InitialWebsiteRolloutError::Inspection(cause));
        }
        if let Some(service) = self.service.take() {
            match service.close() {
                Ok(closed) => self.closed_service = Some(closed),
                Err(cause) => errors.push(InitialWebsiteRolloutError::Maintenance(cause)),
            }
        }
    }
}
impl std::fmt::Debug for InitialWebsiteRolloutFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("InitialWebsiteRolloutFailure")
            .field("operation", &self.operation_id())
            .field("deployment_operation", &self.deployment_operation())
            .field("cause", &self.cause)
            .field("cleanup", &self.cleanup)
            .finish()
    }
}
impl std::fmt::Display for InitialWebsiteRolloutFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause().fmt(out)?;
        if let Some(operation) = self.deployment_operation() {
            write!(out, "; deployment operation {operation}")?;
        }
        Ok(())
    }
}
impl std::error::Error for InitialWebsiteRolloutFailure<'_> {}
impl Drop for InitialWebsiteRolloutFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
        std::mem::forget(self.cause.take());
        std::mem::forget(std::mem::take(&mut self.cleanup));
    }
}
