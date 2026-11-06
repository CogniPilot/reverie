//! Existing worker source/control/attachment validation, using actual native
//! resolution. These are snapshots, not pinned mount or execution authority.
use crate::native;
use reverie_contracts::worker_schema::{WorkerEnvelope, WorkerPath};
use reverie_core::{
    posix_path::{PosixPath, PosixPathError},
    worker_schema::MountTarget,
};
use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};

const WORKSPACE: &str = "/reverie_workspace";
#[derive(Debug)]
pub enum WorkerMountError {
    Io(io::Error),
    Path(PosixPathError),
    ControlState,
    AttachmentDirectory,
    AttachmentAlias,
}
impl WorkerMountError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "WORKER_MOUNT_SOURCE_IO",
            Self::Path(_) => "WORKER_MOUNT_PATH_CODEPOINT",
            Self::ControlState => "WORKER_MOUNT_CONTROL_STATE",
            Self::AttachmentDirectory => "WORKER_ATTACHMENT_REAL_DIRECTORY",
            Self::AttachmentAlias => "WORKER_ATTACHMENT_ALIAS",
        }
    }
}
impl fmt::Display for WorkerMountError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for WorkerMountError {}
impl From<io::Error> for WorkerMountError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<PosixPathError> for WorkerMountError {
    fn from(value: PosixPathError) -> Self {
        Self::Path(value)
    }
}
type Result<T> = std::result::Result<T, WorkerMountError>;

pub struct ObservedWorkerMount {
    resolved: PathBuf,
    resolved_text: PosixPath,
    lexical: PosixPath,
    target: MountTarget,
}
impl ObservedWorkerMount {
    pub fn resolved_source(&self) -> &Path {
        &self.resolved
    }
    /// Native bytes cannot reconstruct Python string provenance. Use this view
    /// for the original validator's lexical comparisons, never fsdecode again.
    pub fn resolved_path_text(&self) -> &PosixPath {
        &self.resolved_text
    }
    pub fn lexical_source(&self) -> &PosixPath {
        &self.lexical
    }
    pub fn destination(&self) -> &MountTarget {
        &self.target
    }
}
pub struct WorkerMountSources {
    mounts: Vec<ObservedWorkerMount>,
}
impl WorkerMountSources {
    pub fn mounts(&self) -> &[ObservedWorkerMount] {
        &self.mounts
    }
}
/// Resolve declared sources strictly, excluding host control state and both
/// lexical/resolved shared-attachment aliases. Source files and symlink aliases
/// remain accepted as in worker.validate_config. Only attachments must be a
/// real directory. Preserve raw command/config source paths in the envelope.
/// Reobserve inside the actual admitted effect; no descriptor remains pinned.
pub fn observe_mount_sources(config: &WorkerEnvelope) -> Result<WorkerMountSources> {
    let state = PosixPath::try_new(config.path(WorkerPath::StateRoot).codepoints())?;
    let broker_parent = PosixPath::try_new(config.path(WorkerPath::Socket).codepoints())?.parent();
    let mut mounts = Vec::new();
    for mount in config.mounts() {
        let source = native::resolve_strict_text(mount.source().codepoints())?;
        let resolved = native::python_path(&source.codepoints())?;
        if source == PosixPath::from_scalar_text("/")
            || source.is_relative_to(&PosixPath::from_scalar_text("/run"))
            || source.is_relative_to(&PosixPath::from_scalar_text("/var/run"))
            || source.is_relative_to(&state)
            || source.is_relative_to(&broker_parent)
        {
            return Err(WorkerMountError::ControlState);
        }
        mounts.push(ObservedWorkerMount {
            resolved,
            resolved_text: source,
            lexical: PosixPath::try_new(mount.source().codepoints())?,
            target: mount.destination().clone(),
        });
    }
    attachments(&mounts)?;
    Ok(WorkerMountSources { mounts })
}
fn attachments(mounts: &[ObservedWorkerMount]) -> Result<()> {
    let workspace = PosixPath::from_scalar_text(WORKSPACE);
    for mount in mounts {
        if PosixPath::try_new(mount.target.codepoints())? != workspace {
            continue;
        }
        let entry = mount
            .resolved_text
            .join(&PosixPath::from_scalar_text("attachments"));
        if !fs::symlink_metadata(native::python_path(&entry.codepoints())?)?.is_dir() {
            return Err(WorkerMountError::AttachmentDirectory);
        }
        let resolved = native::resolve_strict_text(&entry.codepoints())?;
        let lexical = mount
            .lexical
            .join(&PosixPath::from_scalar_text("attachments"));
        for other in mounts {
            let source = &other.resolved_text;
            let overlaps = source.overlaps(&resolved) || other.lexical.overlaps(&lexical);
            if overlaps
                && !(other.resolved_text == mount.resolved_text
                    && PosixPath::try_new(other.target.codepoints())? == workspace)
            {
                return Err(WorkerMountError::AttachmentAlias);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
