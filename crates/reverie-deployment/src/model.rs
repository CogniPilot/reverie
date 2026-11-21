use super::*;
use reverie_core::private_access::{ENABLED, HOSTNAME, WEB_PORT};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
mod image_profile;
mod profile;
pub use profile::DeploymentProfile;
#[cfg(test)]
mod tests;

#[derive(Serialize, Deserialize)]
pub struct DeploymentPreview {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_adoption: Option<crate::ClaimAdoptionPreview>,
    pub operation: String,
    pub container: String,
    pub source_id: String,
    pub source_image: String,
    pub candidate_image: String,
    pub environment_policy: String,
    pub refreshed_environment_keys: Vec<String>,
    pub broker_preserved: bool,
    pub backup_metadata_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<DeploymentProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preserved_networks: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_accounts: Option<crate::live_accounts::LiveAccountDispositionPreview>,
}
#[derive(Serialize, Deserialize)]
pub struct DeploymentStatus {
    pub operation: String,
    pub stage: String,
    pub candidate_id: Option<String>,
    pub source_id: String,
    pub backup_verified: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<Value>,
    /// Last terminal receipt and current observation error, when live readiness is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_failure: Option<ReadinessFailure>,
}
#[derive(Serialize, Deserialize)]
pub struct ReadinessFailure {
    pub recorded_stage: String,
    pub diagnostic: Value,
}
pub(super) fn cid(value: &str) -> Result<&str> {
    require(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "DEPLOYMENT_CANONICAL_ID_REQUIRED",
    )?;
    Ok(value)
}
pub(super) fn image_id(value: &str) -> Result<&str> {
    cid(value
        .strip_prefix("sha256:")
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_IMAGE_ID_REQUIRED"))?)?;
    Ok(value)
}
pub(super) fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ENGINE_METADATA_INVALID"))
}
pub(super) fn projection(value: &Value) -> Value {
    let mut mounts = value["Mounts"].as_array().cloned().unwrap_or_default();
    mounts.sort_by_key(Value::to_string);
    json!({"Id":value["Id"],"Image":value["Image"],"Config":value["Config"],
        "HostConfig":value["HostConfig"],"Mounts":mounts})
}
pub(super) fn supported(source: &Value) -> Result<()> {
    supported_base(source)?;
    profile::source_mounts(source, DeploymentProfile::Ordinary)
}
pub(super) fn supported_profile(source: &Value, selected: DeploymentProfile) -> Result<()> {
    if selected == DeploymentProfile::Ordinary {
        return supported(source);
    }
    supported_base(source)?;
    profile::source_mounts(source, selected)
}
pub(super) fn supported_network_profile(
    source: &Value,
    selected: DeploymentProfile,
    topology: &crate::networks::Topology,
) -> Result<()> {
    supported_base_selection(source, Some(topology))?;
    profile::source_mounts(source, selected)
}
fn supported_base(source: &Value) -> Result<()> {
    supported_base_selection(source, None)
}
fn supported_base_selection(
    source: &Value,
    topology: Option<&crate::networks::Topology>,
) -> Result<()> {
    cid(string(source, "Id")?)?;
    let host = &source["HostConfig"];
    require(
        host["AutoRemove"] == false
            && host["NetworkMode"] == "bridge"
            && host["ContainerIDFile"].as_str().is_none_or(str::is_empty)
            && host["Privileged"] == false,
        "DEPLOYMENT_PROFILE_UNSUPPORTED",
    )?;
    let networks = source["NetworkSettings"]["Networks"]
        .as_object()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_NETWORK_UNSUPPORTED"))?;
    if let Some(topology) = topology {
        topology.require_container(source)?;
    } else {
        require(
            networks.len() == 1 && networks.contains_key("bridge"),
            "DEPLOYMENT_NETWORK_UNSUPPORTED",
        )?;
    }
    if topology.is_none() {
        let network = &networks["bridge"];
        for key in ["Aliases", "IPAMConfig", "Links"] {
            require(network[key].is_null(), "DEPLOYMENT_NETWORK_UNSUPPORTED")?;
        }
    }
    require(
        source["Config"]["Volumes"].is_null(),
        "DEPLOYMENT_ANONYMOUS_VOLUME_UNSUPPORTED",
    )?;
    Ok(())
}
type Environment = BTreeMap<String, String>;

fn wire_environment(values: Environment) -> Value {
    json!(
        values
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
    )
}

/// Apply instance access settings only when recording a new preview. A
/// historical invalid-create receipt must still reconstruct its original body.
pub(super) fn preserve_private_access(
    source: &Value,
    body: &mut Value,
    refreshed: &mut Vec<String>,
) -> Result<()> {
    let selected = environment(&source["Config"])?;
    let mut merged = environment(body)?;
    for setting in [ENABLED, HOSTNAME, WEB_PORT] {
        let value = selected.get(setting.key).map(String::as_str);
        if value.is_some() || merged.contains_key(setting.key) {
            merged.insert(setting.key.into(), value.unwrap_or(setting.default).into());
        }
        refreshed.retain(|key| key != setting.key);
    }
    body["Env"] = wire_environment(merged);
    Ok(())
}

fn environment(config: &Value) -> Result<Environment> {
    let entries = config["Env"]
        .as_array()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ENV_REQUIRED"))?;
    let mut output = Environment::new();
    for entry in entries {
        let entry = entry
            .as_str()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ENV_INVALID"))?;
        let (key, value) = entry
            .split_once('=')
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ENV_INVALID"))?;
        require(
            !key.is_empty() && output.insert(key.into(), value.into()).is_none(),
            "DEPLOYMENT_ENV_DUPLICATE",
        )?;
    }
    Ok(output)
}
/// The original container's selected mode also determines rollback readiness.
/// Absence is the legacy Node service; every explicit mode must select the front.
pub(super) fn uses_front(config: &Value) -> Result<bool> {
    let env = environment(config)?;
    let selected = env.get("REVERIE_NATIVE_FRONT");
    require(
        selected.is_none_or(|value| value == "1"),
        "DEPLOYMENT_FRONT_MODE_UNSUPPORTED",
    )?;
    Ok(selected.is_some())
}
#[cfg(test)]
pub(super) fn create_body(
    source: &Value,
    old_image: &Value,
    candidate: &Value,
) -> Result<(Value, Vec<String>)> {
    create_body_profile(source, old_image, candidate, DeploymentProfile::Ordinary)
}
pub(super) fn create_body_profile(
    source: &Value,
    old_image: &Value,
    candidate: &Value,
    selected_profile: DeploymentProfile,
) -> Result<(Value, Vec<String>)> {
    create_body_selection(source, old_image, candidate, selected_profile, None)
}
pub(super) fn create_body_selection(
    source: &Value,
    old_image: &Value,
    candidate: &Value,
    selected_profile: DeploymentProfile,
    topology: Option<&crate::networks::Topology>,
) -> Result<(Value, Vec<String>)> {
    let entrypoint = image_profile::selected_entrypoint(source, old_image, candidate)?;
    require(
        source["Config"]["Cmd"] == candidate["Config"]["Cmd"],
        "DEPLOYMENT_ENTRYPOINT_CHANGED",
    )?;
    let previous = environment(&old_image["Config"])?;
    let next = environment(&candidate["Config"])?;
    require(
        candidate["Config"]["Volumes"].is_null(),
        "DEPLOYMENT_ANONYMOUS_VOLUME_UNSUPPORTED",
    )?;
    let selected = environment(&source["Config"])?;
    for entries in [&selected, &next] {
        require(
            !entries.contains_key("REVERIE_FRONT_CHILD")
                && !entries.contains_key("REVERIE_NATIVE_FRONT_BIN"),
            "DEPLOYMENT_INTERNAL_FRONT_OVERRIDE",
        )?;
    }
    uses_front(&source["Config"])?;
    require(
        uses_front(&candidate["Config"])?,
        "DEPLOYMENT_IMAGE_FRONT_REQUIRED",
    )?;
    let mut merged = next.clone();
    for (key, value) in selected {
        if previous.get(&key) != Some(&value) && key != "REVERIE_NATIVE_FRONT" {
            merged.insert(key, value);
        }
    }
    merged.insert("REVERIE_NATIVE_FRONT".into(), "1".into());
    let refreshed = previous
        .iter()
        .filter(|(key, value)| next.get(*key) != Some(value))
        .map(|(key, _)| key.clone())
        .collect();
    let mut body = source["Config"].clone();
    add_image_label_defaults(&mut body, &candidate["Config"])?;
    let fields = body
        .as_object_mut()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_CONFIG_REQUIRED"))?;
    fields.insert("Image".into(), candidate["Id"].clone());
    fields.insert("Entrypoint".into(), entrypoint);
    fields.insert("Env".into(), wire_environment(merged));
    fields.insert(
        "HostConfig".into(),
        profile::host(source, selected_profile)?,
    );
    fields.insert(
        "NetworkingConfig".into(),
        match topology {
            Some(topology) => topology.request()?,
            None => json!({"EndpointsConfig":{"bridge":{}}}),
        },
    );
    profile::validate_body(source, &body, selected_profile)?;
    Ok((body, refreshed))
}
pub(super) fn add_image_label_defaults(config: &mut Value, image_config: &Value) -> Result<()> {
    let labels = &image_config["Labels"];
    if labels.is_null() {
        return Ok(());
    }
    let invalid = "DEPLOYMENT_IMAGE_LABELS_INVALID";
    let mut labels = labels
        .as_object()
        .cloned()
        .ok_or_else(|| DeploymentError::new(invalid))?;
    if labels.is_empty() {
        return Ok(());
    }
    if !config["Labels"].is_null() {
        let existing = config["Labels"]
            .as_object()
            .ok_or_else(|| DeploymentError::new(invalid))?;
        labels.extend(existing.clone());
    }
    require(labels.values().all(Value::is_string), invalid)?;
    config["Labels"] = Value::Object(labels);
    Ok(())
}
pub(super) const CREATED_CONFIG_CHANGED: &str = "DEPLOYMENT_CREATED_CONFIG_CHANGED";
pub(super) fn candidate_matches_selection(
    actual: &Value,
    source: &Value,
    body: &Value,
    selected: DeploymentProfile,
    topology: Option<&crate::networks::Topology>,
) -> Result<()> {
    match topology {
        Some(topology) => supported_network_profile(actual, selected, topology)?,
        None => supported_profile(actual, selected)?,
    }
    profile::candidate(actual, selected)?;
    require(
        actual["Image"] == body["Image"],
        "DEPLOYMENT_CREATED_IMAGE_CHANGED",
    )?;
    crate::binds::equivalent_profile(&actual["HostConfig"], &body["HostConfig"], selected)?;
    let mut expected = body.clone();
    expected
        .as_object_mut()
        .expect("create body")
        .remove("HostConfig");
    expected
        .as_object_mut()
        .expect("create body")
        .remove("NetworkingConfig");
    require(actual["Config"] == expected, CREATED_CONFIG_CHANGED)?;
    crate::binds::same_profile_grants(&actual["Mounts"], &source["Mounts"], selected)
}
pub(super) fn source_mounts(source: &Value, selected: DeploymentProfile) -> Result<()> {
    profile::source_mounts(source, selected)
}
pub(super) fn observed_mounts(source: &Value) -> Result<()> {
    profile::observed_mounts(source)
}
pub(super) fn validate_profile_body(
    source: &Value,
    body: &Value,
    selected: DeploymentProfile,
) -> Result<()> {
    profile::validate_body(source, body, selected)
}
pub(super) fn validate_legacy_invalid_body(source: &Value, body: &Value) -> Result<()> {
    profile::validate_legacy_invalid_body(source, body)
}
pub(super) fn normalized_tmpfs(value: &Value) -> Result<Value> {
    profile::normalized_tmpfs(value)
}
pub(super) fn normalized_security_options(value: &Value) -> Result<Value> {
    profile::normalized_security_options(value)
}
pub(super) fn port_binding(source: &Value, port: u16) -> Result<()> {
    let bindings = source["HostConfig"]["PortBindings"]
        .as_object()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_PORT_BINDING_REQUIRED"))?;
    require(bindings.len() == 1, "DEPLOYMENT_PORT_BINDING_UNSUPPORTED")?;
    let values = bindings
        .get("3000/tcp")
        .and_then(Value::as_array)
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_PORT_BINDING_REQUIRED"))?;
    let expected_port = port.to_string();
    require(
        values.len() == 1
            && values[0]["HostIp"] == "127.0.0.1"
            && values[0]["HostPort"].as_str() == Some(expected_port.as_str()),
        "DEPLOYMENT_PORT_BINDING_MISMATCH",
    )
}
