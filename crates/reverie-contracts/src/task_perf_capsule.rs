//! Build inventory DATA, never an image approval or native execution grant.
use reverie_core::operations::JournalDigest;
use serde::Deserialize;
use std::{collections::BTreeMap, fmt, path::Component};

pub const MAX_INVENTORY_BYTES: usize = 4 * 1024 * 1024;
pub const PREFIX: &str = "/opt/reverie/perf";
pub const ABSENT_PREFIX: &str = "/opt/rvprf";
pub const WORKER_INIT: &str = "/opt/reverie/perf/bin/reverie-worker-init";
pub const IMAGE_MANIFEST_LABEL: &str = "org.reverie.worker.perf-capsule-manifest";

/// Image metadata DATA only. Trusted factory/source qualification and actual
/// guest init/inventory readback remain independently required by their owners.
pub fn assert_image_binding(
    raw: &[u8],
    expected_image: &str,
    expected_manifest: &str,
) -> Result<()> {
    #[derive(Deserialize)]
    struct Image {
        #[serde(rename = "Id")]
        id: String,
        #[serde(rename = "Config")]
        config: Config,
    }
    #[derive(Deserialize)]
    struct Config {
        #[serde(rename = "Labels")]
        labels: BTreeMap<String, String>,
    }
    if raw.len() > MAX_INVENTORY_BYTES {
        return Err(PerfCapsuleDataError);
    }
    let images: Vec<Image> = serde_json::from_slice(raw).map_err(|_| PerfCapsuleDataError)?;
    if images.len() != 1
        || images[0].id != expected_image
        || images[0]
            .config
            .labels
            .get(IMAGE_MANIFEST_LABEL)
            .map(String::as_str)
            != Some(expected_manifest)
    {
        return Err(PerfCapsuleDataError);
    }
    Ok(())
}

#[derive(Debug)]
pub struct PerfCapsuleDataError;
impl fmt::Display for PerfCapsuleDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("TASK_PERF_CAPSULE_INVENTORY_INVALID")
    }
}
impl std::error::Error for PerfCapsuleDataError {}
type Result<T> = std::result::Result<T, PerfCapsuleDataError>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wire {
    schema: String,
    purpose: String,
    prefix: String,
    absent_fallback: String,
    absent_system_preload: String,
    closure_input_sha256: String,
    artifacts: Vec<Artifact>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    input: String,
    input_sha256: String,
    output: String,
    sha256: String,
}
pub struct PerfCapsuleInventory {
    code: BTreeMap<String, JournalDigest>,
}
impl PerfCapsuleInventory {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        if raw.len() > MAX_INVENTORY_BYTES {
            return Err(PerfCapsuleDataError);
        }
        let wire: Wire = serde_json::from_slice(raw).map_err(|_| PerfCapsuleDataError)?;
        if wire.schema != "reverie-perf-guest-capsule-build-v2"
            || wire.purpose != "unselected-image-data-no-grant-or-attestation"
            || wire.prefix != PREFIX
            || wire.absent_fallback != "/opt/rvprf/"
            || wire.absent_system_preload != "/opt/rvprf/preload.off"
            || JournalDigest::parse(&wire.closure_input_sha256).is_err()
            || wire.artifacts.len() > 16_384
        {
            return Err(PerfCapsuleDataError);
        }
        let mut code = BTreeMap::new();
        let mut seen = std::collections::BTreeSet::new();
        for artifact in wire.artifacts {
            let selected = validate(&artifact)?;
            if !seen.insert(artifact.output.clone()) {
                return Err(PerfCapsuleDataError);
            }
            if selected {
                code.insert(
                    artifact.output,
                    JournalDigest::parse(&artifact.sha256).map_err(|_| PerfCapsuleDataError)?,
                );
            }
        }
        if !code.contains_key("bin/perf")
            || !code.contains_key("bin/reverie-perf-check")
            || !code.contains_key("bin/reverie-worker-init")
            || code.len() < 4
            || code.len() > 256
        {
            return Err(PerfCapsuleDataError);
        }
        Ok(Self { code })
    }
    pub fn code_files(&self) -> &BTreeMap<String, JournalDigest> {
        &self.code
    }
}
fn validate(artifact: &Artifact) -> Result<bool> {
    let path = std::path::Path::new(&artifact.output);
    if artifact.output.is_empty()
        || artifact.output.contains('\0')
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || !artifact.input.starts_with("/nix/store/")
        || JournalDigest::parse(&artifact.input_sha256).is_err()
        || JournalDigest::parse(&artifact.sha256).is_err()
    {
        return Err(PerfCapsuleDataError);
    }
    if artifact.output.starts_with("notices/") {
        return Ok(false);
    }
    let executable = matches!(
        artifact.output.as_str(),
        "bin/perf" | "bin/reverie-perf-check" | "bin/reverie-worker-init"
    );
    let library = artifact.output.strip_prefix("lib/").is_some_and(|name| {
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
            && name != "."
            && name != ".."
    });
    if !executable && !library {
        return Err(PerfCapsuleDataError);
    }
    Ok(true)
}

#[cfg(test)]
mod tests;
