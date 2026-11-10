//! Initial whole owner: retained service IMAGE fence across website deployment
//! and actual actor setup. No broker/worker restart or pool consent is inferred.
use crate::{
    DeploymentError, DeploymentPreview, DeploymentProfile, DeploymentService, DeploymentStatus,
};
use reverie_application::{
    installing_broker::{
        InstallingBroker, OfflineActorSetupClosed, OfflineActorSetupFailure,
        PreparedOfflineActorSetup,
    },
    reservation_gate::GateError,
    worker_validation::{WorkerValidationError, load_owner_config},
};
use reverie_contracts::{
    reservation_engine::ReservationConfiguration,
    resource_actor::{ResourceActorDataError, ResourceActorSettings},
    worker_config,
};
use reverie_core::operations::JournalId;
use reverie_host::{
    resource_facts::{ResourceFactsError, fresh_owner_nonce},
    worker_service::{
        ClosedImageServiceMaintenance, DeploymentServiceQuiesceFailure, ImageServiceMaintenance,
        NativeWorkerServiceRole, quiesce_stopped_worker_service,
    },
};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
mod error;
mod run;
pub use error::{InitialWebsiteRolloutError, InitialWebsiteRolloutFailure};
type RolloutResult<'a, T> = std::result::Result<T, InitialWebsiteRolloutError<'a>>;
struct Owner<'a> {
    broker: &'a InstallingBroker,
    root: PathBuf,
    source: PathBuf,
    image: String,
    operation: Option<JournalId>,
    deployment: Option<DeploymentService>,
    preview: Option<DeploymentPreview>,
    status: Option<DeploymentStatus>,
    service: Option<ImageServiceMaintenance>,
    closed_service: Option<ClosedImageServiceMaintenance>,
    actor: Option<PreparedOfflineActorSetup<'a>>,
    actor_attempted: bool,
    input: reverie_host::website_facts::ImmutableInputObserver,
    deployment_close_attempted: bool,
    end: Instant,
}
pub struct InitialWebsiteRolloutClosed {
    operation: JournalId,
    deployment: DeploymentStatus,
    actor: OfflineActorSetupClosed,
}
impl InitialWebsiteRolloutClosed {
    pub fn operation_id(&self) -> &str {
        self.operation.as_str()
    }
    pub fn deployment_status(&self) -> &DeploymentStatus {
        &self.deployment
    }
    pub fn actor_configuration_digest(&self) -> &str {
        self.actor.configuration_digest().as_str()
    }
    pub fn actor_preview_digest(&self) -> &str {
        self.actor.preview_digest().as_str()
    }
}
/// OS-owner initial installation only. The broker must be the original stable
/// unstarted installing instance, not reconstructed after an unknown outcome.
pub fn rollout_initial_website<'a>(
    broker: &'a InstallingBroker,
    root: &Path,
    source: &Path,
    image: &str,
    end: Instant,
) -> std::result::Result<InitialWebsiteRolloutClosed, Box<InitialWebsiteRolloutFailure<'a>>> {
    let mut owner = Box::new(Owner {
        broker,
        root: root.to_owned(),
        source: source.to_owned(),
        image: image.to_owned(),
        operation: None,
        deployment: None,
        preview: None,
        status: None,
        service: None,
        closed_service: None,
        actor: None,
        actor_attempted: false,
        input: Default::default(),
        deployment_close_attempted: false,
        end,
    });
    match owner.run() {
        Ok(closed) => Ok(closed),
        Err(cause) => Err(InitialWebsiteRolloutFailure::new(owner, cause)),
    }
}
fn require<'a>(value: bool, code: &'static str) -> RolloutResult<'a, ()> {
    value
        .then_some(())
        .ok_or(InitialWebsiteRolloutError::Refused(code))
}
