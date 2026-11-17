//! Refresh only the fixed GPU image ABI from the owner's immutable image
//! selection. A path, request flag or matching label alone grants no profile.
use super::*;

const INVALID: &str = "DEPLOYMENT_ENTRYPOINT_CHANGED";
const NIX_BASE32: &[u8] = b"0123456789abcdfghijklmnpqrsvwxyz";

/// Only the runtime's store hash may change. A different runtime package
/// version or entrypoint shape requires its own reviewed ABI transition.
fn gpu_version(entrypoint: &Value) -> Option<&str> {
    let fields = entrypoint.as_array()?;
    if fields.len() != 6
        || fields[0] != "/bin/tini"
        || fields[1] != "-g"
        || fields[2] != "-s"
        || fields[3] != "--"
        || fields[5] != "/usr/local/bin/reverie-start"
    {
        return None;
    }
    let path = fields[4].as_str()?.strip_prefix("/nix/store/")?;
    let (package, leaf) = path.split_once('/')?;
    if leaf != "bin/reverie-container-runtime"
        || !package
            .get(..32)?
            .bytes()
            .all(|byte| NIX_BASE32.contains(&byte))
    {
        return None;
    }
    let version = package
        .get(32..)?
        .strip_prefix("-reverie-container-runtime-")?;
    let parts: Vec<_> = version.split('.').collect();
    (parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 10
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        }))
    .then_some(version)
}

pub(super) fn selected_entrypoint(
    source: &Value,
    old_image: &Value,
    candidate: &Value,
) -> Result<Value> {
    let original = &source["Config"]["Entrypoint"];
    let selected = &candidate["Config"]["Entrypoint"];
    if original == selected {
        return Ok(original.clone());
    }
    // These are actual image inspection results captured by DeploymentService,
    // not request-supplied execution vectors or a new image-trust assertion.
    let old_id = image_id(string(old_image, "Id")?)?;
    let selected_id = image_id(string(candidate, "Id")?)?;
    require(
        source["Image"] == old_id && selected_id != old_id,
        "DEPLOYMENT_SOURCE_IMAGE_CHANGED",
    )?;
    require(original == &old_image["Config"]["Entrypoint"], INVALID)?;
    let version = gpu_version(original).ok_or_else(|| DeploymentError::new(INVALID))?;
    require(gpu_version(selected) == Some(version), INVALID)?;
    Ok(selected.clone())
}
