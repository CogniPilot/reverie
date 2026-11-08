//! Offline image maintenance has a separate stopped-service interlock. Image
//! qualification below is readonly and supplies no publication/start authority.
use super::*;
use crate::reservation_observer::ObservationContext;
use reverie_contracts::{
    resource_actor::{ArtifactReference, EngineMetadata, WorkerImageProvenance},
    worker_image_switch::WorkerImageId,
};
use reverie_host::website_facts::{ImmutableInputKind, ImmutableInputObserver};
use std::time::{Duration, Instant};
mod error;
mod qualification;
pub use error::{WorkerImageQualificationError, WorkerImageQualificationFailure};
type Result<T> = std::result::Result<T, WorkerImageQualificationError>;
/// Owns the SAME native input observer/context used to qualify an exact loaded
/// image. It cannot be deserialized, cloned or constructed from profile DATA.
pub struct QualifiedWorkerImage<'a> {
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
}
impl Drop for QualifiedWorkerImage<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
