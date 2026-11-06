use super::*;
use std::{sync::Arc, time::Instant};
#[derive(Clone, Copy, Eq, PartialEq)]
enum Release {
    NotSubmitted,
    Attempted,
    Confirmed,
}
/// Fixed pending-file creation provenance, not permission to publish or reload.
/// No Drop unlinks, no constructor from metadata, and an attempted release is
/// never retried. The real application retains this record on uncertainty.
pub struct GpuPendingFile {
    path: PathBuf,
    stamp: GpuFileStamp,
    intent: Arc<GpuTransitionIntent>,
    end: Instant,
    release: Release,
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
        let body = write_pending(
            &directory,
            path.file_name().expect("pending leaf"),
            intent.bytes(),
        );
        let stamp = finalized(body, native::close(directory).map_err(Into::into))?;
        let read = self.read_pending()?;
        need(
            read.stamp == stamp && intent.matches_metadata(&read.metadata),
            "GPU_PRIVATE_FILE_CHANGED",
        )?;
        Ok(GpuPendingFile {
            path,
            stamp,
            intent,
            end,
            release: Release::NotSubmitted,
        })
    }
}
fn write_pending(directory: &File, name: &OsStr, bytes: &[u8]) -> Result<GpuFileStamp> {
    let mut file = native::create_policy_temporary(directory, name)?;
    let body = (|| {
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        let stamp = GpuFileStamp::of(&file.metadata()?);
        need(
            stamp.private(native::policy_effective_uid()),
            "GPU_PRIVATE_FILE",
        )?;
        Ok(stamp)
    })();
    let stamp = finalized(body, native::close(file).map_err(Into::into))?;
    directory.sync_all()?;
    Ok(stamp)
}
impl GpuPendingFile {
    pub fn assert_current(&self, files: &GpuControlFiles) -> Result<()> {
        need(
            self.release == Release::NotSubmitted && self.path == files.pending_path()?,
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
        &self.path
    }
    /// Invoke only after every native producer/checked finalizer and terminal
    /// parent/leaf recheck. Named pending identity is LAST; no fallible owned
    /// descriptor finalization follows unlink. This remains cooperative CAS,
    /// not an atomic inode-conditioned unlink against same-UID noncooperators.
    pub fn release(&mut self) -> Result<()> {
        need(
            self.release == Release::NotSubmitted,
            "GPU_APPLY_REQUIRES_RECONCILIATION",
        )?;
        need(
            GpuFileStamp::observe(&self.path)? == self.stamp,
            "GPU_TERMINAL_CAS_CHANGED",
        )?;
        need(Instant::now() < self.end, "GPU_APPLY_DEADLINE")?;
        self.release = Release::Attempted;
        fs::remove_file(&self.path)
            .map_err(|error| GpuHostError::PublicationUnknown(Box::new(error.into())))?;
        self.release = Release::Confirmed;
        Ok(())
    }
}
