//! Build-time bytes only. Paths are manifest data, never installed-file custody.
use super::{MAX_ARTIFACT_BYTES, PerfSystem, Result, TaskPerfError, TaskPerfProfile, key, scalar};
use crate::legacy_json::{Node, Number, Value};
use reverie_core::task_perf::TaskPerfPolicy;
use std::collections::BTreeMap;

pub struct TaskPerfProducedBytes {
    profile: Vec<u8>,
    manifest: Vec<u8>,
}
impl TaskPerfProducedBytes {
    pub fn profile(&self) -> &[u8] {
        &self.profile
    }
    pub fn manifest(&self) -> &[u8] {
        &self.manifest
    }
}
/// Preserve the existing producer's default-spaced sorted ASCII JSON plus one
/// newline. The installed reader independently checks Nix paths, custody,
/// bounds, system and both hashes; producer output grants none of those facts.
pub fn produce_task_perf(
    base_profile: &str,
    selected_profile: &str,
    system: PerfSystem,
    base: &[u8],
) -> Result<TaskPerfProducedBytes> {
    produce_task_perf_for_policy(
        TaskPerfPolicy::TaskV1,
        base_profile,
        selected_profile,
        system,
        base,
    )
}
pub fn produce_task_perf_for_policy(
    policy: TaskPerfPolicy,
    base_profile: &str,
    selected_profile: &str,
    system: PerfSystem,
    base: &[u8],
) -> Result<TaskPerfProducedBytes> {
    let mut profile = TaskPerfProfile::decode(base)?
        .derivative_for_policy(policy)?
        .encode();
    profile.push(b'\n');
    if profile.len() > MAX_ARTIFACT_BYTES {
        return Err(TaskPerfError::ArtifactBound);
    }
    let fields = BTreeMap::from([
        (
            key("version"),
            Value(Node::Number(Number::Integer(
                super::manifest_version(policy).into(),
            ))),
        ),
        (key("purpose"), scalar(super::manifest_purpose(policy))),
        (key("system"), scalar(system.name())),
        (key("baseProfile"), scalar(base_profile)),
        (
            key("baseSHA256"),
            scalar(&super::profile::artifact_sha256(base)),
        ),
        (key("profile"), scalar(selected_profile)),
        (
            key("profileSHA256"),
            scalar(&super::profile::artifact_sha256(&profile)),
        ),
    ]);
    let mut manifest = crate::worker_config::encode_data(&Value(Node::Object(fields)));
    manifest.push(b'\n');
    if manifest.len() > MAX_ARTIFACT_BYTES {
        return Err(TaskPerfError::ArtifactBound);
    }
    Ok(TaskPerfProducedBytes { profile, manifest })
}
