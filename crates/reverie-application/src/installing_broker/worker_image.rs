//! Offline image maintenance has a separate stopped-service interlock. Image
//! qualification below is readonly and supplies no publication/start authority.
use super::*;
use crate::reservation_observer::ObservationContext;
use reverie_contracts::{
    resource_actor::{ArtifactReference, EngineMetadata, WorkerImageProvenance},
    worker_image_switch::WorkerImageId,
};
use reverie_host::website_facts::{ImmutableInputKind, ImmutableInputObserver};
use std::{
    rc::Rc,
    time::{Duration, Instant},
};
mod apply;
pub(super) mod broker_close;
pub use broker_close::{ClosedOfflineImageInspection, OfflineImageInspectionFailure};
mod error;
mod preflight;
mod prepare;
pub use apply::{OfflineImageSwitchClosed, OfflineImageSwitchError, OfflineImageSwitchFailure};
mod qualification;
#[cfg(test)]
mod tests;
pub use error::{WorkerImageQualificationError, WorkerImageQualificationFailure};
type Result<T> = std::result::Result<T, WorkerImageQualificationError>;
/// Owns the SAME native input observer/context used to qualify an exact loaded
/// image. It cannot be deserialized, cloned or constructed from profile DATA.
pub struct QualifiedWorkerImage<'a> {
    owner: Option<Box<Qualification<'a>>>,
}
/// Frozen readonly preview owned by the original native qualifier. It is not
/// deserializable and cannot publish without the real service/lock/R owners.
pub struct PreparedOfflineImageSwitch<'a> {
    owner: Option<Box<Qualification<'a>>>,
}
struct Qualification<'a> {
    broker: &'a InstallingBroker,
    before: Arc<ValidatedWorkerSnapshot>,
    base: ArtifactReference,
    annex: ArtifactReference,
    image: WorkerImageId,
    input: ImmutableInputObserver,
    context: ObservationContext,
    end: Instant,
    failed: bool,
    recheck_close_failure: Option<Rc<WorkerImageQualificationError>>,
    preview_files: Option<reverie_host::worker_image::ImageControlFiles>,
    preview: Option<crate::reservation_gate::ImageSwitchPreview>,
    file_close_failure: Option<reverie_host::worker_image::ImageFileError>,
    preflight_locks: Option<reverie_host::worker_image::ImageMaintenanceLocks>,
    preflight_failure: Option<Box<reverie_host::worker_image::ImageMaintenanceFailure>>,
}
impl Drop for PreparedOfflineImageSwitch<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl Drop for QualifiedWorkerImage<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
