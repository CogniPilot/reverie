//! Fixed installed perf artifact observations and current-employee bracketing.
use crate::{ObservationError, native};
use reverie_contracts::storage_identity::CurrentEmployee;
use reverie_contracts::task_perf_v1::{
    MAX_ARTIFACT_BYTES, PerfSystem, TaskPerfArtifactData, TaskPerfConfiguration, TaskPerfError,
    TaskPerfManifest, TaskPerfProfile, TaskPerfProjection,
};
use reverie_core::ids::ProfileSessionId;
use reverie_store::storage_identity::{self, IdentityError, StorageIdentityConfig};
use std::os::unix::fs::MetadataExt;
use std::{
    fmt,
    path::{Path, PathBuf},
};

const FIXED_MANIFEST: Option<&str> = option_env!("REVERIE_FIXED_TASK_PERF_MANIFEST");

#[derive(Debug)]
pub enum TaskPerfHostError {
    Unconfigured,
    Observation(ObservationError),
    Data(TaskPerfError),
    Identity(IdentityError),
    CurrentEmployeeChanged,
}
impl TaskPerfHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unconfigured => "TASK_PERF_FIXED_ARTIFACT_UNCONFIGURED",
            Self::Observation(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Identity(error) => error.code(),
            Self::CurrentEmployeeChanged => "TASK_PERF_EMPLOYEE_BINDING_CHANGED",
        }
    }
}
impl fmt::Display for TaskPerfHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for TaskPerfHostError {}
impl From<ObservationError> for TaskPerfHostError {
    fn from(error: ObservationError) -> Self {
        Self::Observation(error)
    }
}
impl From<TaskPerfError> for TaskPerfHostError {
    fn from(error: TaskPerfError) -> Self {
        Self::Data(error)
    }
}
impl From<IdentityError> for TaskPerfHostError {
    fn from(error: IdentityError) -> Self {
        Self::Identity(error)
    }
}
type Result<T> = std::result::Result<T, TaskPerfHostError>;

/// Freshly observed fixed artifact data, not an owner or execution capability.
pub struct InstalledTaskPerfArtifact {
    data: TaskPerfArtifactData,
}
impl InstalledTaskPerfArtifact {
    pub fn data(&self) -> &TaskPerfArtifactData {
        &self.data
    }
    pub fn into_data(self) -> TaskPerfArtifactData {
        self.data
    }
}

trait ArtifactSource {
    fn manifest(&self) -> Result<PathBuf>;
    fn read(&self, path: &Path) -> Result<Vec<u8>>;
}
struct Installed;
impl ArtifactSource for Installed {
    fn manifest(&self) -> Result<PathBuf> {
        FIXED_MANIFEST
            .map(PathBuf::from)
            .ok_or(TaskPerfHostError::Unconfigured)
    }
    fn read(&self, path: &Path) -> Result<Vec<u8>> {
        let path = native::canonical_in(path, Path::new("/nix/store"))?;
        Ok(native::observe(
            &path,
            MAX_ARTIFACT_BYTES,
            allowed_metadata,
        )?)
    }
}
pub(crate) fn allowed_metadata(metadata: &std::fs::Metadata) -> bool {
    (metadata.uid() == 0 || metadata.uid() == native::uid()) && metadata.mode() & 0o022 == 0
}
fn artifact(source: &impl ArtifactSource) -> Result<InstalledTaskPerfArtifact> {
    let (system, machine) = native::system()?;
    let system = PerfSystem::from_linux_uname(&system, &machine)?;
    let manifest = TaskPerfManifest::decode(&source.read(&source.manifest()?)?, system)?;
    let base = source.read(Path::new(manifest.base_profile()))?;
    let selected = source.read(Path::new(manifest.profile()))?;
    Ok(InstalledTaskPerfArtifact {
        data: TaskPerfArtifactData::verify(manifest, &base, &selected)?,
    })
}

/// Observe only the compile/package-bound sibling successor. There is no
/// configuration, environment, wire or public caller-selected artifact pathname.
pub fn observe_installed_task_perf() -> Result<InstalledTaskPerfArtifact> {
    artifact(&Installed)
}

/// The identity configuration must come from the same captured worker domain.
/// No profile is observed for an empty map or an unselected current employee.
pub fn project_task_perf(
    config: &TaskPerfConfiguration,
    identity: &StorageIdentityConfig,
    session: &ProfileSessionId,
) -> Result<TaskPerfProjection> {
    project(
        config,
        || Ok(storage_identity::current_employee(identity, session)?),
        &Installed,
    )
}
fn project(
    config: &TaskPerfConfiguration,
    mut current: impl FnMut() -> Result<Option<CurrentEmployee>>,
    source: &impl ArtifactSource,
) -> Result<TaskPerfProjection> {
    if config.policies().entries().is_empty() {
        return Ok(config.project(None, None)?);
    }
    let before = current()?;
    let employee = before.as_ref().map(CurrentEmployee::identity);
    if config.policies().selected(employee).is_none() {
        return Ok(config.project(employee, None)?);
    }
    let fixed = artifact(source)?;
    let candidate = config.project(employee, Some(fixed.data()))?;
    if current()? != before {
        return Err(TaskPerfHostError::CurrentEmployeeChanged);
    }
    Ok(candidate)
}

/// This recognizes only the fixed selected artifact/marker relationship.
/// Full rootless Docker validation, current authorization and kernel checks
/// remain independent responsibilities of the consuming broker.
pub fn recognized_task_perf(
    config: &TaskPerfConfiguration,
    profile: &TaskPerfProfile,
) -> Result<()> {
    if !config.has_task_perf_marker() {
        return Err(TaskPerfError::Marker.into());
    }
    Ok(config.recognized(observe_installed_task_perf()?.data(), profile)?)
}

#[cfg(test)]
mod tests;
