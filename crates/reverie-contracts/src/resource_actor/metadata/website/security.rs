use super::*;

pub(super) fn check(item: &Value, mounts: &Value) -> Result<()> {
    let host = required(item, "HostConfig")?;
    let host =
        object(host).map_err(|_| ResourceActorDataError("PROTECTED_WEBSITE_NAMESPACE_REQUIRED"))?;
    need(
        matches!(
            host.get(&key("ReadonlyRootfs")),
            Some(Value(Node::Bool(true)))
        ) && matches!(host.get(&key("Privileged")), Some(Value(Node::Bool(false))))
            && cap_drop(host.get(&key("CapDrop")))
            && cap_add(host.get(&key("CapAdd")))
            && host
                .get(&key("PidMode"))
                .is_some_and(|value| matches_text(value, "") || matches_text(value, "private"))
            && security_options(host.get(&key("SecurityOpt"))),
        "PROTECTED_WEBSITE_NAMESPACE_REQUIRED",
    )?;
    mounts::require_unmasked(mounts)?;
    environment(required(item, "Config")?)
}

/// Pure candidate settings only: no container, process or owner is qualified.
pub(super) fn settings(raw: &[u8]) -> Result<()> {
    need(raw.len() <= MAX_ENGINE_BODY, "ENGINE_METADATA_UNAVAILABLE")?;
    let value = legacy_json::decode_strict_bytes(raw)
        .map_err(|_| ResourceActorDataError("ENGINE_METADATA_UNAVAILABLE"))?;
    closed(&value, &["Config", "HostConfig", "Mounts"])?;
    let mounts = mounts::normalize(required(&value, "Mounts")?)?;
    check(&value, &mounts)
}
fn cap_drop(value: Option<&Value>) -> bool {
    matches!(value, Some(Value(Node::Array(values))) if values.len() == 1 && matches_text(&values[0], "ALL"))
}
fn cap_add(value: Option<&Value>) -> bool {
    match value {
        Some(Value(Node::Null)) => true,
        Some(Value(Node::Array(values))) => values.is_empty(),
        _ => false,
    }
}
fn security_options(value: Option<&Value>) -> bool {
    let accepted = |value: &Value| {
        matches_text(value, "no-new-privileges") || matches_text(value, "no-new-privileges:true")
    };
    match value.map(|value| &value.0) {
        Some(Node::Array(values)) => values.iter().any(accepted),
        // Original `any(... for value in ...)` iterates dictionary keys too.
        Some(Node::Object(values)) => values.keys().any(|key| {
            key.equals_ascii("no-new-privileges") || key.equals_ascii("no-new-privileges:true")
        }),
        _ => false,
    }
}
fn environment(config: &Value) -> Result<()> {
    let entries = field(config, "Env")
        .and_then(array)
        .map_err(|_| ResourceActorDataError("FIXED_BACKEND_ENV_REQUIRED"))?;
    need(
        entries.len() <= 256
            && entries
                .iter()
                .all(|value| matches!(value.0, Node::String(_))),
        "FIXED_BACKEND_ENV_REQUIRED",
    )?;
    for entry in entries {
        let Node::String(value) = &entry.0 else {
            unreachable!("checked environment strings");
        };
        let name = value.0.split(|&point| point == 61).next().expect("split");
        need(
            !value.0.starts_with(&[76, 68, 95])
                && ![
                    "NODE_OPTIONS",
                    "NODE_PATH",
                    "PYTHONPATH",
                    "PYTHONHOME",
                    "GCONV_PATH",
                    "OPENSSL_CONF",
                    "OPENSSL_MODULES",
                ]
                .iter()
                .any(|denied| name.iter().copied().eq(denied.bytes().map(u32::from))),
            "BACKEND_LOADER_ENV_REFUSED",
        )?;
    }
    Ok(())
}
