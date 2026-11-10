//! One owner-local initial actor installation, under the actual stopped native
//! service and original R. No worker stop/start, OS offer or fleet grant occurs.
use super::worker_image::{OfflineImageSwitchError, broker_close::UnstartedImageBroker};
use super::*;
use crate::reservation_gate::{ActorSetupAdmission, ActorSetupPreview};
use reverie_core::operations::{JournalDigest, JournalId};
use reverie_host::{
    gpu_access::{ActorSetupControlFiles, ActorSetupPending, ActorSetupTerminal},
    resource_facts::{
        ActorSetupFacts, ActorSetupFactsError, ActorSetupHistoryError, ActorSetupHistoryObservation,
    },
    worker_image::{ClosedImageMaintenance, ImageMaintenanceLocks},
    worker_service::{ClosedImageServiceMaintenance, ImageServiceMaintenance},
};
use std::{rc::Rc, time::Instant};
mod error;
mod prepare;
mod publish;
pub use error::{OfflineActorSetupError, OfflineActorSetupFailure};
type Result<'a, T> = std::result::Result<T, OfflineActorSetupError<'a>>;
pub struct PreparedOfflineActorSetup<'a> {
    owner: Option<Box<Owner<'a>>>,
}
struct Owner<'a> {
    broker: &'a InstallingBroker,
    refresh: bool,
    broker_close: UnstartedImageBroker<'a>,
    files: Option<ActorSetupControlFiles>,
    facts: Option<ActorSetupFacts>,
    history: Option<ActorSetupHistoryObservation>,
    preview: Option<ActorSetupPreview>,
    digest: Option<JournalDigest>,
    admission: Option<ActorSetupAdmission<'a>>,
    service: Option<ImageServiceMaintenance>,
    closed_service: Option<ClosedImageServiceMaintenance>,
    locks: Option<ImageMaintenanceLocks>,
    closed_locks: Option<ClosedImageMaintenance>,
    pending: Option<ActorSetupPending>,
    terminal: Option<ActorSetupTerminal>,
    end: Instant,
}
pub struct OfflineActorSetupClosed {
    configuration: JournalDigest,
    preview: JournalDigest,
}
impl OfflineActorSetupClosed {
    pub fn configuration_digest(&self) -> &JournalDigest {
        &self.configuration
    }
    pub fn preview_digest(&self) -> &JournalDigest {
        &self.preview
    }
}
impl InstallingBroker {
    pub fn prepare_offline_actor_setup(
        &self,
        end: Instant,
    ) -> std::result::Result<PreparedOfflineActorSetup<'_>, Box<OfflineActorSetupFailure<'_>>> {
        self.prepare_actor_mode(end, false)
    }
    pub fn prepare_offline_actor_refresh(
        &self,
        end: Instant,
    ) -> std::result::Result<PreparedOfflineActorSetup<'_>, Box<OfflineActorSetupFailure<'_>>> {
        self.prepare_actor_mode(end, true)
    }
    fn prepare_actor_mode(
        &self,
        end: Instant,
        refresh: bool,
    ) -> std::result::Result<PreparedOfflineActorSetup<'_>, Box<OfflineActorSetupFailure<'_>>> {
        let mut owner = Box::new(Owner {
            broker: self,
            refresh,
            broker_close: UnstartedImageBroker::new(self),
            files: None,
            facts: None,
            history: None,
            preview: None,
            digest: None,
            admission: None,
            service: None,
            closed_service: None,
            locks: None,
            closed_locks: None,
            pending: None,
            terminal: None,
            end,
        });
        match owner.prepare() {
            Ok(()) => Ok(PreparedOfflineActorSetup { owner: Some(owner) }),
            Err(cause) => Err(OfflineActorSetupFailure::new(owner, cause)),
        }
    }
}
impl<'a> PreparedOfflineActorSetup<'a> {
    pub fn preview_digest(&self) -> &JournalDigest {
        self.owner
            .as_ref()
            .expect("same actor owner")
            .digest
            .as_ref()
            .expect("actual actor preview")
    }
    pub fn configuration_digest(&self) -> JournalDigest {
        configuration(
            self.owner
                .as_ref()
                .expect("same actor owner")
                .preview
                .as_ref()
                .expect("actual actor preview"),
        )
    }
    pub fn assert_current(
        mut self,
        end: Instant,
    ) -> std::result::Result<Self, Box<OfflineActorSetupFailure<'a>>> {
        let mut owner = self.owner.take().expect("same actor owner");
        owner.end = owner.end.min(end);
        match owner.assert_current() {
            Ok(()) => Ok(Self { owner: Some(owner) }),
            Err(cause) => Err(OfflineActorSetupFailure::new(owner, cause)),
        }
    }
    pub fn close(
        mut self,
        end: Instant,
    ) -> std::result::Result<(), Box<OfflineActorSetupFailure<'a>>> {
        let mut owner = self.owner.take().expect("same actor owner");
        owner.end = owner.end.min(end);
        match owner.close_inspection() {
            Ok(()) => Ok(()),
            Err(cause) => Err(OfflineActorSetupFailure::new(owner, cause)),
        }
    }
    pub fn apply(
        mut self,
        service: ImageServiceMaintenance,
        expected: &JournalDigest,
        operation: &JournalId,
    ) -> std::result::Result<OfflineActorSetupClosed, Box<OfflineActorSetupFailure<'a>>> {
        let mut owner = self.owner.take().expect("same actor owner");
        owner.end = owner.end.min(service.end());
        owner.service = Some(service);
        match owner.run(expected, operation) {
            Ok(closed) => Ok(closed),
            Err(cause) => Err(OfflineActorSetupFailure::new(owner, cause)),
        }
    }
}
impl Drop for PreparedOfflineActorSetup<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
fn configuration(preview: &ActorSetupPreview) -> JournalDigest {
    JournalDigest::parse(
        &reverie_contracts::worker_config::config_digest(preview.intent.after()).to_hex(),
    )
    .expect("SHA256")
}
fn require<'a>(value: bool, code: &'static str) -> Result<'a, ()> {
    value
        .then_some(())
        .ok_or(OfflineActorSetupError::Refused(code))
}
