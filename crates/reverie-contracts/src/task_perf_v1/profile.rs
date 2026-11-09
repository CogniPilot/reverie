use super::TaskPerfManifest;
use super::{Result, TaskPerfError, bounded_json, key, object, string};
use crate::legacy_json::{self, Node, Value};
use reverie_core::task_perf::TaskPerfPolicy;
use sha2::{Digest, Sha256};

/// A lossless seccomp JSON document, including unknown base-profile fields.
/// It neither supplies kernel syscall permission nor validates all Docker rules.
pub struct TaskPerfProfile(Value);
impl TaskPerfProfile {
    /// Already decoded normal seccomp data may use last-key-wins JSON. This
    /// does not qualify a fixed artifact or relax its separate strict decoder.
    pub(crate) fn from_rootless_value(value: Value) -> Self {
        Self(value)
    }
    pub fn decode(raw: &[u8]) -> Result<Self> {
        Ok(Self(bounded_json(raw)?))
    }
    pub fn encode(&self) -> Vec<u8> {
        crate::worker_config::encode_data(&self.0)
    }
    pub fn equivalent(&self, other: &Self) -> bool {
        self.0.python_eq(&other.0)
    }
    pub fn derivative(&self) -> Result<Self> {
        self.derivative_for_policy(TaskPerfPolicy::TaskV1)
    }
    pub fn derivative_for_policy(&self, policy: TaskPerfPolicy) -> Result<Self> {
        let fields = object(&self.0).ok_or(TaskPerfError::DefaultDeny)?;
        if fields
            .get(&key("defaultAction"))
            .and_then(string)
            .as_deref()
            != Some("SCMP_ACT_ERRNO")
        {
            return Err(TaskPerfError::DefaultDeny);
        }
        let Some(Value(Node::Array(rules))) = fields.get(&key("syscalls")) else {
            return Err(TaskPerfError::DefaultDeny);
        };
        let rule = rule_value(policy)?;
        if rules.iter().any(|existing| existing.python_eq(&rule)) {
            return Err(TaskPerfError::AlreadyApplied);
        }
        if policy == TaskPerfPolicy::TaskV2 {
            let legacy = rule_value(TaskPerfPolicy::TaskV1)?;
            if rules.iter().any(|existing| existing.python_eq(&legacy)) {
                return Err(TaskPerfError::AlreadyApplied);
            }
        }
        let mut derived = self.0.deep_clone();
        let Node::Object(fields) = &mut derived.0 else {
            unreachable!("checked object");
        };
        let Some(Value(Node::Array(rules))) = fields.get_mut(&key("syscalls")) else {
            unreachable!("checked syscall list");
        };
        rules.push(rule);
        Ok(Self(derived))
    }
}
pub(crate) fn is_task_perf_rule(value: &Value, policy: TaskPerfPolicy) -> Result<bool> {
    Ok(value.python_eq(&rule_value(policy)?))
}
fn rule_value(policy: TaskPerfPolicy) -> Result<Value> {
    let rule = policy.rule();
    let args = rule
        .arguments()
        .iter()
        .map(|arg| {
            format!(
                r#"{{"index":{},"value":{},"valueTwo":{},"op":"{}"}}"#,
                arg.index(),
                arg.mask(),
                arg.expected(),
                arg.operator()
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let raw = format!(
        r#"{{"names":["{}"],"action":"{}","args":[{}]}}"#,
        rule.syscall(),
        rule.action(),
        args,
    );
    Ok(legacy_json::decode_utf8(raw.as_bytes())?)
}

/// Hash-bound manifest/profile data, without any assertion of native custody.
pub struct TaskPerfArtifactData {
    manifest: TaskPerfManifest,
    base: TaskPerfProfile,
    selected: TaskPerfProfile,
}
impl TaskPerfArtifactData {
    pub fn verify(manifest: TaskPerfManifest, base: &[u8], selected: &[u8]) -> Result<Self> {
        if base.len() > super::MAX_ARTIFACT_BYTES || selected.len() > super::MAX_ARTIFACT_BYTES {
            return Err(TaskPerfError::ArtifactBound);
        }
        if artifact_sha256(base) != manifest.base_sha256()
            || artifact_sha256(selected) != manifest.profile_sha256()
        {
            return Err(TaskPerfError::Digest);
        }
        let base = TaskPerfProfile::decode(base)?;
        let selected = TaskPerfProfile::decode(selected)?;
        if !selected.equivalent(&base.derivative_for_policy(manifest.policy())?) {
            return Err(TaskPerfError::Derivative);
        }
        Ok(Self {
            manifest,
            base,
            selected,
        })
    }
    pub fn manifest(&self) -> &TaskPerfManifest {
        &self.manifest
    }
    pub fn base(&self) -> &TaskPerfProfile {
        &self.base
    }
    pub fn selected(&self) -> &TaskPerfProfile {
        &self.selected
    }
}
pub(super) fn artifact_sha256(raw: &[u8]) -> String {
    crate::digest::hex(&Sha256::digest(raw).into())
}
