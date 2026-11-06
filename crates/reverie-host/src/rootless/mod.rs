//! Read-only rootless qualification and argument data. No engine invocation,
//! owner authorization, capability activation or held mount/start permit.
#[cfg(test)]
mod tests;
use crate::{ObservationError, native};
use reverie_contracts::rootless::{
    MAX_PROFILE_BYTES, MAX_SUBID_BYTES, RootlessConfig, RootlessError, RootlessImage,
    parse_host_grants,
};
use reverie_contracts::storage_identity::MetadataText;
use reverie_contracts::task_perf_v1::TaskPerfArtifactData;
use reverie_core::rootless::SubordinateRange;
use std::os::unix::fs::MetadataExt;
use std::{fmt, fs, path::Path};

#[derive(Debug)]
pub enum RootlessHostError {
    Observation(ObservationError),
    Data(RootlessError),
    Perf(crate::task_perf::TaskPerfHostError),
    OwnerMismatch,
    SubIds,
}
impl RootlessHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Observation(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Perf(error) => error.code(),
            Self::OwnerMismatch => "ROOTLESS_BROKER_OWNER",
            Self::SubIds => "ROOTLESS_HOST_SUBIDS",
        }
    }
}
impl fmt::Display for RootlessHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for RootlessHostError {}
impl From<ObservationError> for RootlessHostError {
    fn from(value: ObservationError) -> Self {
        Self::Observation(value)
    }
}
impl From<RootlessError> for RootlessHostError {
    fn from(value: RootlessError) -> Self {
        Self::Data(value)
    }
}
type Result<T> = std::result::Result<T, RootlessHostError>;

/// Fresh readonly observations and corresponding argument data. Revalidate
/// immediately before engine use; this value is neither a lease nor authority.
pub struct RootlessObservation {
    enabled: bool,
    security: Vec<MetadataText>,
    runtime: Vec<MetadataText>,
}
impl RootlessObservation {
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn security_args(&self) -> &[MetadataText] {
        &self.security
    }
    pub fn runtime_args(&self) -> &[MetadataText] {
        &self.runtime
    }
}
trait Source {
    fn profile(&self, config: &RootlessConfig) -> Result<Vec<u8>>;
    fn perf(&self) -> Result<TaskPerfArtifactData>;
    fn uid(&self) -> u32;
    fn grants(&self, kind: GrantKind, uid: u32) -> Result<Vec<SubordinateRange>>;
}
#[derive(Clone, Copy)]
enum GrantKind {
    Uid,
    Gid,
}
struct Installed;
impl Source for Installed {
    fn profile(&self, config: &RootlessConfig) -> Result<Vec<u8>> {
        let path = config.profile_path().ok_or(RootlessError::Path)?;
        let normalized = reverie_core::posix_path::PosixPath::try_new(path.codepoints())
            .map_err(|_| RootlessError::Path)?;
        let resolved =
            native::resolve_strict_text(path.codepoints()).map_err(ObservationError::Io)?;
        if resolved != normalized {
            return Err(RootlessError::Path.into());
        }
        let path =
            native::python_path(&normalized.codepoints()).map_err(|_| RootlessError::Path)?;
        let path = native::canonical_in(&path, Path::new("/nix/store"))?;
        Ok(native::observe(
            &path,
            MAX_PROFILE_BYTES,
            crate::task_perf::allowed_metadata,
        )?)
    }
    fn perf(&self) -> Result<TaskPerfArtifactData> {
        crate::task_perf::observe_installed_task_perf()
            .map(|artifact| artifact.into_data())
            .map_err(RootlessHostError::Perf)
    }
    fn uid(&self) -> u32 {
        native::uid()
    }
    fn grants(&self, kind: GrantKind, uid: u32) -> Result<Vec<SubordinateRange>> {
        let path = match kind {
            GrantKind::Uid => Path::new("/etc/subuid"),
            GrantKind::Gid => Path::new("/etc/subgid"),
        };
        let target = fs::canonicalize(path).map_err(ObservationError::Io)?;
        let name = native::username(uid)?;
        let raw = observe_grants(&target)?;
        Ok(parse_host_grants(&raw, &name, uid)?)
    }
}
fn observe_grants(path: &Path) -> Result<Vec<u8>> {
    Ok(native::observe(path, MAX_SUBID_BYTES, |metadata| {
        metadata.uid() == 0 && metadata.mode() & 0o022 == 0
    })?)
}
fn observe(config: &RootlessConfig, source: &impl Source) -> Result<RootlessObservation> {
    if config.enabled() {
        let bytes = source.profile(config)?;
        let prepared = config
            .prepare_profile(&bytes)?
            .ok_or(RootlessError::Option)?;
        let fixed = config
            .needs_perf_recognition()
            .then(|| source.perf())
            .transpose()?;
        config.check_prepared_profile(&prepared, fixed.as_ref())?;
    }
    Ok(RootlessObservation {
        enabled: config.enabled(),
        security: config.security_args(),
        runtime: config.runtime_args(),
    })
}
pub fn observe_rootless(config: &RootlessConfig) -> Result<RootlessObservation> {
    observe(config, &Installed)
}
pub fn require_rootless_accounts(
    config: &RootlessConfig,
    accounts: &[MetadataText],
) -> Result<RootlessObservation> {
    let observed = observe_rootless(config)?;
    config.check_accounts(accounts)?;
    Ok(observed)
}
/// Image is caller-captured engine-inspection DATA. This does not prove that a
/// particular engine/image remains selected; the consuming workflow owns that.
pub fn require_rootless_image(
    config: &RootlessConfig,
    image: &RootlessImage,
) -> Result<RootlessObservation> {
    image_observation(config, image, &Installed)
}
fn image_observation(
    config: &RootlessConfig,
    image: &RootlessImage,
    source: &impl Source,
) -> Result<RootlessObservation> {
    let observed = observe(config, source)?;
    let Some(image) = config.image_identity(image)? else {
        return Ok(observed);
    };
    let uid = config.ids().ok_or(RootlessError::Identity)?.uid();
    if uid != source.uid() {
        return Err(RootlessHostError::OwnerMismatch);
    }
    let mappings = image.mappings()?;
    if !mappings.count_sufficient() {
        return Err(RootlessHostError::SubIds);
    }
    let uids = source.grants(GrantKind::Uid, uid)?;
    // Python short-circuits before reading subgid if the UID range is absent.
    if !mappings.uid_granted(&uids) {
        return Err(RootlessHostError::SubIds);
    }
    let gids = source.grants(GrantKind::Gid, uid)?;
    if !mappings.granted(&uids, &gids) {
        return Err(RootlessHostError::SubIds);
    }
    Ok(observed)
}
