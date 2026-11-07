use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
pub struct DeploymentPreview {
    pub operation: String,
    pub container: String,
    pub source_id: String,
    pub source_image: String,
    pub candidate_image: String,
    pub environment_policy: String,
    pub refreshed_environment_keys: Vec<String>,
    pub broker_preserved: bool,
    pub backup_metadata_scope: String,
}
#[derive(Serialize, Deserialize)]
pub struct DeploymentStatus {
    pub operation: String,
    pub stage: String,
    pub candidate_id: Option<String>,
    pub source_id: String,
    pub backup_verified: Option<bool>,
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
    require(
        networks.len() == 1 && networks.contains_key("bridge"),
        "DEPLOYMENT_NETWORK_UNSUPPORTED",
    )?;
    let network = &networks["bridge"];
    for key in ["Aliases", "IPAMConfig", "Links"] {
        require(network[key].is_null(), "DEPLOYMENT_NETWORK_UNSUPPORTED")?;
    }
    let mounts = source["Mounts"]
        .as_array()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_MOUNTS_REQUIRED"))?;
    require(
        !mounts.is_empty() && mounts.iter().all(|m| m["Type"] == "bind"),
        "DEPLOYMENT_MOUNTS_UNSUPPORTED",
    )?;
    require(
        source["Config"]["Volumes"].is_null(),
        "DEPLOYMENT_ANONYMOUS_VOLUME_UNSUPPORTED",
    )?;
    Ok(())
}
fn environment(config: &Value) -> Result<Vec<String>> {
    let entries = config["Env"]
        .as_array()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ENV_REQUIRED"))?;
    let mut keys = BTreeMap::new();
    let mut output = Vec::new();
    for entry in entries {
        let entry = entry
            .as_str()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ENV_INVALID"))?;
        let (key, _) = entry
            .split_once('=')
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ENV_INVALID"))?;
        require(
            !key.is_empty() && keys.insert(key, ()).is_none(),
            "DEPLOYMENT_ENV_DUPLICATE",
        )?;
        output.push(entry.to_owned());
    }
    Ok(output)
}
pub(super) fn create_body(
    source: &Value,
    old_image: &Value,
    candidate: &Value,
) -> Result<(Value, Vec<String>)> {
    require(
        source["Config"]["Entrypoint"] == candidate["Config"]["Entrypoint"]
            && source["Config"]["Cmd"] == candidate["Config"]["Cmd"],
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
            !entries.iter().any(|e| {
                e.starts_with("REVERIE_FRONT_CHILD=") || e.starts_with("REVERIE_NATIVE_FRONT_BIN=")
            }),
            "DEPLOYMENT_INTERNAL_FRONT_OVERRIDE",
        )?;
    }
    require(
        !selected
            .iter()
            .any(|e| e.starts_with("REVERIE_NATIVE_FRONT=")),
        "DEPLOYMENT_SOURCE_ALREADY_SELECTS_FRONT",
    )?;
    require(
        !next.iter().any(|e| e.starts_with("REVERIE_NATIVE_FRONT=")),
        "DEPLOYMENT_IMAGE_SELECTS_FRONT",
    )?;
    let mut merged: BTreeMap<String, String> = next
        .iter()
        .map(|e| {
            let (k, _) = e.split_once('=').expect("validated env");
            (k.to_owned(), e.clone())
        })
        .collect();
    for entry in selected {
        let (key, _) = entry.split_once('=').expect("validated env");
        if !previous.contains(&entry) && key != "REVERIE_NATIVE_FRONT" {
            merged.insert(key.to_owned(), entry);
        }
    }
    merged.insert(
        "REVERIE_NATIVE_FRONT".into(),
        "REVERIE_NATIVE_FRONT=1".into(),
    );
    let refreshed = previous
        .iter()
        .filter(|entry| !next.contains(entry))
        .map(|e| e.split_once('=').expect("validated env").0.to_owned())
        .collect();
    let mut body = source["Config"].clone();
    let fields = body
        .as_object_mut()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_CONFIG_REQUIRED"))?;
    fields.insert("Image".into(), candidate["Id"].clone());
    fields.insert(
        "Env".into(),
        json!(merged.into_values().collect::<Vec<_>>()),
    );
    fields.insert("HostConfig".into(), crate::binds::project(source)?);
    fields.insert(
        "NetworkingConfig".into(),
        json!({"EndpointsConfig":{"bridge":{}}}),
    );
    Ok((body, refreshed))
}
pub(super) fn candidate_matches(actual: &Value, source: &Value, body: &Value) -> Result<()> {
    supported(actual)?;
    require(
        actual["Image"] == body["Image"],
        "DEPLOYMENT_CREATED_IMAGE_CHANGED",
    )?;
    crate::binds::equivalent(&actual["HostConfig"], &body["HostConfig"])?;
    let mut expected = body.clone();
    expected
        .as_object_mut()
        .expect("create body")
        .remove("HostConfig");
    expected
        .as_object_mut()
        .expect("create body")
        .remove("NetworkingConfig");
    require(
        actual["Config"] == expected,
        "DEPLOYMENT_CREATED_CONFIG_CHANGED",
    )?;
    crate::binds::same_grants(&actual["Mounts"], &source["Mounts"])
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
