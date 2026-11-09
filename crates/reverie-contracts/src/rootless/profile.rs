use super::*;
use crate::legacy_json;
use crate::task_perf_v1::{TaskPerfArtifactData, TaskPerfProfile, recognize_configuration};
use reverie_core::task_perf::TaskPerfPolicy;
use sha2::{Digest, Sha256};

/// Parsed default-deny profile DATA, bound to exact bytes. Not native custody.
pub struct PreparedRootlessProfile {
    value: Value,
    digest: [u8; 32],
}
fn digest_matches(option: &EnabledOption, digest: &[u8; 32]) -> Result<()> {
    let expected = option.digest.scalar_text().ok_or(RootlessError::Digest)?;
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || crate::digest::hex(digest) != expected
    {
        return Err(RootlessError::Digest);
    }
    Ok(())
}
pub(super) fn prepare(option: &EnabledOption, raw: &[u8]) -> Result<PreparedRootlessProfile> {
    if raw.len() > MAX_PROFILE_BYTES {
        return Err(RootlessError::ProfileBound);
    }
    let digest = Sha256::digest(raw).into();
    digest_matches(option, &digest)?;
    let value = legacy_json::decode_rootless_profile(raw).map_err(|_| RootlessError::Json)?;
    let fields = object(&value).map_err(|_| RootlessError::Profile)?;
    if !matches!(field(fields,"defaultAction"), Some(Value(Node::String(value))) if value.equals_ascii("SCMP_ACT_ERRNO"))
    {
        return Err(RootlessError::Profile);
    }
    Ok(PreparedRootlessProfile { value, digest })
}
pub(super) fn check(
    config: &EffectiveWorkerConfig,
    option: &EnabledOption,
    prepared: &PreparedRootlessProfile,
    artifact: Option<&TaskPerfArtifactData>,
) -> Result<()> {
    digest_matches(option, &prepared.digest)?;
    let value = &prepared.value;
    let fields = object(value).map_err(|_| RootlessError::Profile)?;
    let perf = field(object(config.as_value())?, "_taskPerfPolicy").is_some();
    let policy = if perf {
        let artifact = artifact.ok_or(RootlessError::Perf)?;
        let profile = TaskPerfProfile::from_rootless_value(value.deep_clone());
        recognize_configuration(config, artifact, &profile).map_err(|_| RootlessError::Perf)?;
        Some(artifact.manifest().policy())
    } else {
        None
    };
    let rules = field(fields, "syscalls").ok_or(RootlessError::Syscalls)?;
    match &rules.0 {
        Node::Array(rules) => {
            for rule in rules {
                check_rule(rule, policy)?;
            }
        }
        Node::Object(values) if values.is_empty() => {}
        Node::String(value) if value.0.is_empty() => {}
        _ => return Err(RootlessError::Syscalls),
    }
    Ok(())
}
fn check_rule(rule: &Value, policy: Option<TaskPerfPolicy>) -> Result<()> {
    let fields = object(rule).map_err(|_| RootlessError::Syscalls)?;
    let guarded = caps(fields, "includes")?;
    let excluded = caps(fields, "excludes")?;
    let applies = (guarded.empty || guarded.intersects) && !excluded.intersects;
    if applies {
        let action = field(fields, "action").ok_or(RootlessError::Syscalls)?;
        if matches!(&action.0, Node::String(value) if value.equals_ascii("SCMP_ACT_ALLOW")) {
            let names = field(fields, "names").ok_or(RootlessError::Syscalls)?;
            let forbidden = iterable(
                names,
                &["keyctl", "add_key", "request_key", "bpf", "perf_event_open"],
            )?;
            if forbidden.intersects
                && !policy
                    .map(|policy| exact_perf_rule(rule, policy))
                    .transpose()?
                    .unwrap_or(false)
            {
                return Err(RootlessError::Syscalls);
            }
        }
    }
    Ok(())
}
fn exact_perf_rule(rule: &Value, policy: TaskPerfPolicy) -> Result<bool> {
    crate::task_perf_v1::is_task_perf_rule(rule, policy).map_err(|_| RootlessError::Perf)
}
struct SetView {
    empty: bool,
    intersects: bool,
}
fn caps(fields: &Object, name: &str) -> Result<SetView> {
    let Some(value) = field(fields, name) else {
        return Ok(SetView {
            empty: true,
            intersects: false,
        });
    };
    let fields = object(value).map_err(|_| RootlessError::Syscalls)?;
    match field(fields, "caps") {
        None => Ok(SetView {
            empty: true,
            intersects: false,
        }),
        Some(value) => iterable(value, &["CAP_SETUID", "CAP_SETGID"]),
    }
}
fn iterable(value: &Value, wanted: &[&str]) -> Result<SetView> {
    let matches = |text: &Text| wanted.iter().any(|name| text.equals_ascii(name));
    match &value.0 {
        Node::Array(values) => {
            if values
                .iter()
                .any(|value| matches!(value.0, Node::Array(_) | Node::Object(_)))
            {
                return Err(RootlessError::Syscalls);
            }
            Ok(SetView {
                empty: values.is_empty(),
                intersects: values
                    .iter()
                    .any(|value| matches!(&value.0, Node::String(text) if matches(text))),
            })
        }
        Node::Object(values) => Ok(SetView {
            empty: values.is_empty(),
            intersects: values.keys().any(matches),
        }),
        Node::String(text) => Ok(SetView {
            empty: text.0.is_empty(),
            intersects: text.0.iter().any(|&point| matches(&Text(vec![point]))),
        }),
        _ => Err(RootlessError::Syscalls),
    }
}
