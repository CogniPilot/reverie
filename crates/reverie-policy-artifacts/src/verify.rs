//! Generated artifact DATA validation for developer acceptance. This does not
//! establish installed custody, select an employee or configure/start a seat.
use super::*;
use reverie_contracts::task_perf_v1::{TaskPerfArtifactData, TaskPerfManifest};
pub(super) fn profile(manifest: &Path) -> Result<String, Box<dyn std::error::Error>> {
    if !cfg!(target_os = "linux") {
        return Err("native perf acceptance requires Linux".into());
    }
    let system = PerfSystem::from_linux_uname("Linux", std::env::consts::ARCH)?;
    let manifest =
        TaskPerfManifest::decode(&output::read_bounded(manifest, MAX_ARTIFACT_BYTES)?, system)?;
    let base = output::read_bounded(Path::new(manifest.base_profile()), MAX_ARTIFACT_BYTES)?;
    let selected = output::read_bounded(Path::new(manifest.profile()), MAX_ARTIFACT_BYTES)?;
    let checked = TaskPerfArtifactData::verify(manifest, &base, &selected)?;
    Ok(checked.manifest().profile().to_owned())
}
