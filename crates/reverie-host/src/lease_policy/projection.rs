use super::{PeerArtifactObservation, Result, native_path, observe_peer_artifact};
use crate::native;
use reverie_contracts::lease_policy::{LeaseConfig, select_company};
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_core::ids::ProfileSessionId;
use reverie_core::lease_policy::LeaseAbsolutePath;
use std::os::unix::fs::MetadataExt;

/// Full read-side lease projection data. This carries no permission to invoke a
/// peer, start a process, mount an artifact or acknowledge an outer operation.
pub struct LeaseObservation {
    config: EffectiveWorkerConfig,
    artifact: Option<PeerArtifactObservation>,
}
impl LeaseObservation {
    pub fn config(&self) -> &EffectiveWorkerConfig {
        &self.config
    }
    pub fn artifact(&self) -> Option<&PeerArtifactObservation> {
        self.artifact.as_ref()
    }
    pub fn into_config(self) -> EffectiveWorkerConfig {
        self.config
    }
}
pub(super) trait Source {
    fn company(&self, config: &LeaseConfig) -> Result<Vec<u8>>;
    fn artifact(&self, path: &LeaseAbsolutePath) -> Result<PeerArtifactObservation>;
}
struct Installed;
impl Source for Installed {
    fn company(&self, config: &LeaseConfig) -> Result<Vec<u8>> {
        company(config)
    }
    fn artifact(&self, path: &LeaseAbsolutePath) -> Result<PeerArtifactObservation> {
        observe_peer_artifact(path)
    }
}
pub(super) fn company(config: &LeaseConfig) -> Result<Vec<u8>> {
    let path = native_path(&config.company_file()?)?;
    // I.read_path(uid,1MiB) checks UID and nlink but deliberately has no022
    // write-mode gate. Do not substitute the stricter employee storage reader.
    Ok(native::observe_with_ancestors(&path, 1024 * 1024, |info| {
        config.metadata_uid_matches(info.uid()) && info.nlink() == 1
    })?
    .bytes)
}
/// Resolve only the configured current EID/SID, read its artifact only when this
/// SID is selected, and preserve every unrelated effective-config value.
pub fn project_lease(config: LeaseConfig, session: &ProfileSessionId) -> Result<LeaseObservation> {
    project(config, session, &Installed)
}
pub(super) fn project(
    config: LeaseConfig,
    session: &ProfileSessionId,
    source: &impl Source,
) -> Result<LeaseObservation> {
    let Some(option) = config.option() else {
        return Ok(LeaseObservation {
            config: config.project(session, None)?.into_config(),
            artifact: None,
        });
    };
    let selected = select_company(&source.company(&config)?, option.employee())?;
    let artifact = if selected.session() == session {
        Some(source.artifact(option.peer_binary())?)
    } else {
        None
    };
    let projection = config.project(session, Some(&selected))?;
    Ok(LeaseObservation {
        config: projection.into_config(),
        artifact,
    })
}
