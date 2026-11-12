use super::*;
use crate::private_pending::{PendingError, PendingFile};
use crate::reservation_control::{AdmissionAcquisition, AdmissionLock};
use crate::worker_runtime::WorkerStopBudget;
use std::{sync::Arc, time::Instant};
mod actor_publication;
pub(crate) use actor_publication::GpuRenameFence;
pub use actor_publication::{GpuActorPublication, GpuActorPublicationInput};
/// Fixed pending-file creation provenance, not permission to publish or reload.
/// No Drop unlinks, no constructor from metadata, and an attempted release is
/// never retried. The real application retains this record on uncertainty.
pub struct GpuPendingFile {
    file: PendingFile,
    stamp: GpuFileStamp,
    intent: Arc<GpuTransitionIntent>,
    end: Instant,
    actor_owner: Option<ActorPendingOwner>,
    actor_attempted: bool,
    actor_custody: Option<Box<actor_publication::PublicationCustody>>,
}
struct ActorPendingOwner {
    admission: Arc<AdmissionAcquisition>,
    stop: WorkerStopBudget,
    request: GpuFileStamp,
}
impl GpuControlFiles {
    /// This can partially create durable evidence even on Err. The application
    /// must retain its own actual attempt slot BEFORE invoking this constructor.
    pub fn publish_pending(
        &self,
        intent: Arc<GpuTransitionIntent>,
        end: Instant,
    ) -> Result<GpuPendingFile> {
        self.publish_pending_selected(intent, end, None)
    }
    pub fn publish_pending_with_actor(
        &self,
        intent: Arc<GpuTransitionIntent>,
        end: Instant,
        admission: &AdmissionLock,
        stop: &WorkerStopBudget,
        request: &GpuFileStamp,
    ) -> Result<GpuPendingFile> {
        admission
            .assert_current(&self.config, intent.before_binding())
            .map_err(admission_error)?;
        let selected = self
            .read_requests()?
            .ok_or(GpuHostError::Refused("GPU_REQUEST_CHANGED"))?;
        let document = reverie_contracts::gpu_access::decode_requests(selected.metadata())?;
        need(
            selected.stamp() == request && intent.matches_requests(&document),
            "GPU_REQUEST_CHANGED",
        )?;
        need(Instant::now() < end, "GPU_APPLY_DEADLINE")?;
        self.publish_pending_selected(
            intent,
            end,
            Some(ActorPendingOwner {
                admission: Arc::clone(admission.acquisition()),
                stop: stop.clone(),
                request: request.clone(),
            }),
        )
    }
    fn publish_pending_selected(
        &self,
        intent: Arc<GpuTransitionIntent>,
        end: Instant,
        actor_owner: Option<ActorPendingOwner>,
    ) -> Result<GpuPendingFile> {
        let path = self.pending_path()?;
        let parent = path
            .parent()
            .ok_or(GpuHostError::Refused("GPU_PARENT_CUSTODY"))?;
        let directory = open_parent(parent)?;
        let owner = native::policy_effective_uid();
        let file = match &actor_owner {
            Some(actor) => PendingFile::create_with_stop(
                directory,
                path,
                intent.bytes(),
                owner,
                end,
                &actor.stop,
            ),
            None => PendingFile::create(directory, path, intent.bytes(), owner),
        }
        .map_err(gpu_error)?;
        let stamp = GpuFileStamp::from_native(file.stamp().clone());
        // The protected producer retains the known created owner before its
        // fallible named readback. The legacy call still checks before return.
        if actor_owner.is_none() {
            let read = self.read_pending()?;
            need(
                read.stamp == stamp && intent.matches_metadata(&read.metadata),
                "GPU_PRIVATE_FILE_CHANGED",
            )?;
        }
        Ok(GpuPendingFile {
            file,
            stamp,
            intent,
            end,
            actor_owner,
            actor_attempted: false,
            actor_custody: None,
        })
    }
}
impl GpuPendingFile {
    pub fn assert_current(&self, files: &GpuControlFiles) -> Result<()> {
        assert_pending(files, &self.file, &self.stamp, &self.intent)
    }
    pub fn stamp(&self) -> &GpuFileStamp {
        &self.stamp
    }
    pub(super) fn path(&self) -> &Path {
        self.file.path()
    }
    /// Invoke only after every native producer/checked finalizer and terminal
    /// parent/leaf recheck. Named pending identity is LAST; no fallible owned
    /// descriptor finalization follows unlink. This remains cooperative CAS,
    /// not an atomic inode-conditioned unlink against same-UID noncooperators.
    pub fn release(&mut self) -> Result<()> {
        need(self.actor_owner.is_none(), "GPU_ACTOR_PUBLICATION_REQUIRED")?;
        self.file.release(Some(self.end)).map_err(gpu_error)
    }
}
fn assert_pending(
    files: &GpuControlFiles,
    pending: &PendingFile,
    stamp: &GpuFileStamp,
    intent: &GpuTransitionIntent,
) -> Result<()> {
    need(
        pending.unreleased() && pending.path() == files.pending_path()?,
        "GPU_TRANSITION_PENDING_CHANGED",
    )?;
    let read = files.read_pending()?;
    need(
        read.stamp == *stamp && intent.matches_metadata(&read.metadata),
        "GPU_TRANSITION_PENDING_CHANGED",
    )
}
fn admission_error(cause: crate::reservation_control::ControlHostError) -> GpuHostError {
    GpuHostError::AdmissionFence(Box::new(cause))
}
pub(super) fn gpu_error(error: PendingError) -> GpuHostError {
    match error {
        PendingError::Io(error) => error.into(),
        PendingError::Native(error) => error.into(),
        PendingError::Parent => GpuHostError::Refused("GPU_PARENT_CUSTODY"),
        PendingError::Private => GpuHostError::Refused("GPU_PRIVATE_FILE"),
        PendingError::AlreadyAttempted => {
            GpuHostError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION")
        }
        PendingError::Changed => GpuHostError::Refused("GPU_TERMINAL_CAS_CHANGED"),
        PendingError::Deadline => GpuHostError::Refused("GPU_APPLY_DEADLINE"),
        PendingError::Finalized { primary, secondary } => GpuHostError::Finalized {
            primary: Box::new(gpu_error(*primary)),
            secondary: Box::new(gpu_error(*secondary)),
        },
        PendingError::PublicationUnknown(error) => {
            GpuHostError::PublicationUnknown(Box::new(gpu_error(*error)))
        }
    }
}
