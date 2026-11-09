use super::*;
use crate::private_pending::{PendingError, PendingFile};
use std::{sync::Arc, time::Instant};
/// Fixed pending-file creation provenance, not permission to publish or reload.
/// No Drop unlinks, no constructor from metadata, and an attempted release is
/// never retried. The real application retains this record on uncertainty.
pub struct GpuPendingFile {
    file: PendingFile,
    stamp: GpuFileStamp,
    intent: Arc<GpuTransitionIntent>,
    end: Instant,
}
impl GpuControlFiles {
    /// This can partially create durable evidence even on Err. The application
    /// must retain its own actual attempt slot BEFORE invoking this constructor.
    pub fn publish_pending(
        &self,
        intent: Arc<GpuTransitionIntent>,
        end: Instant,
    ) -> Result<GpuPendingFile> {
        let path = self.pending_path()?;
        let parent = path
            .parent()
            .ok_or(GpuHostError::Refused("GPU_PARENT_CUSTODY"))?;
        let directory = open_parent(parent)?;
        let file = PendingFile::create(
            directory,
            path,
            intent.bytes(),
            native::policy_effective_uid(),
        )
        .map_err(gpu_error)?;
        let stamp = GpuFileStamp::from_native(file.stamp().clone());
        let read = self.read_pending()?;
        need(
            read.stamp == stamp && intent.matches_metadata(&read.metadata),
            "GPU_PRIVATE_FILE_CHANGED",
        )?;
        Ok(GpuPendingFile {
            file,
            stamp,
            intent,
            end,
        })
    }
}
impl GpuPendingFile {
    pub fn assert_current(&self, files: &GpuControlFiles) -> Result<()> {
        need(
            self.file.unreleased() && self.file.path() == files.pending_path()?,
            "GPU_TRANSITION_PENDING_CHANGED",
        )?;
        let read = files.read_pending()?;
        need(
            read.stamp == self.stamp && self.intent.matches_metadata(&read.metadata),
            "GPU_TRANSITION_PENDING_CHANGED",
        )
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
        self.file.release(Some(self.end)).map_err(gpu_error)
    }
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
