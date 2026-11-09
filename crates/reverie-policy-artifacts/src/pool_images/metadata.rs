use super::{
    archive::MAX_METADATA,
    error::{Error, Result, need},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    #[serde(rename = "Config")]
    pub config: String,
    #[serde(rename = "RepoTags")]
    _tags: Option<Vec<String>>,
    #[serde(rename = "Layers")]
    pub layers: Vec<String>,
}
pub(super) fn manifest(raw: &[u8]) -> Result<Manifest> {
    need(raw.len() <= MAX_METADATA, "POOL_IMAGE_METADATA_BOUND")?;
    let mut items: Vec<Manifest> =
        serde_json::from_slice(raw).map_err(|_| Error::Refused("POOL_IMAGE_MANIFEST"))?;
    need(items.len() == 1, "POOL_IMAGE_ONE_IMAGE_REQUIRED")?;
    let value = items.remove(0);
    need(
        value.config.strip_suffix(".json").is_some_and(hex),
        "POOL_IMAGE_CONFIG_MEMBER",
    )?;
    need(
        !value.layers.is_empty()
            && value.layers.len() <= 256
            && value
                .layers
                .iter()
                .all(|s| s.strip_suffix("/layer.tar").is_some_and(hex))
            && value.layers.iter().collect::<BTreeSet<_>>().len() == value.layers.len(),
        "POOL_IMAGE_LAYER_MEMBERS",
    )?;
    Ok(value)
}
pub(super) fn config(
    raw: &[u8],
    selected: &Manifest,
    controller: bool,
    system: &str,
) -> Result<Value> {
    need(
        raw.len() <= MAX_METADATA && format!("{:x}.json", Sha256::digest(raw)) == selected.config,
        "POOL_IMAGE_CONFIG_DIGEST",
    )?;
    let value: Value =
        serde_json::from_slice(raw).map_err(|_| Error::Refused("POOL_IMAGE_CONFIG"))?;
    let architecture = if system == "x86_64-linux" {
        "amd64"
    } else {
        "arm64"
    };
    need(
        value["architecture"] == architecture && value["os"] == "linux",
        "POOL_IMAGE_PLATFORM",
    )?;
    let root = &value["rootfs"];
    let layers = root["diff_ids"]
        .as_array()
        .ok_or(Error::Refused("POOL_IMAGE_ROOTFS"))?;
    need(
        root["type"] == "layers"
            && layers.len() == selected.layers.len()
            && layers.iter().all(|v| {
                v.as_str()
                    .is_some_and(|s| s.strip_prefix("sha256:").is_some_and(hex))
            }),
        "POOL_IMAGE_ROOTFS",
    )?;
    let config = &value["config"];
    let (entry, cmd) = if controller {
        ("/bin/reverie-worker-resource-controller", json!([]))
    } else {
        ("/bin/sleep", json!(["infinity"]))
    };
    need(
        config["Entrypoint"] == json!([entry])
            && config["Cmd"] == cmd
            && config["Env"] == json!(["PATH=/bin", "LANG=C.UTF-8"])
            && config["User"] == "0:0"
            && config["WorkingDir"] == "/",
        "POOL_IMAGE_FACTORY_ROLE",
    )?;
    Ok(
        json!({"Config":config,"RootFS":{"Type":"layers","Layers":layers},"Architecture":architecture,"Os":"linux","Created":value["created"]}),
    )
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
