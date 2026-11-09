//! Build-only diagnostic of the SAME Host compiler-selected reference.
use reverie_core::PythonTextRef;
use reverie_host::worker_pool::compiled_pool_image_inputs_reference;
use std::{io, path::Path};

/// A build-only diagnostic companion. Its copied JSON never creates authority;
/// the real reachable typed getter above preserves the actual compiled choice.
pub(super) fn publish_reference(package: &Path) -> io::Result<()> {
    let Some(reference) = compiled_pool_image_inputs_reference()? else {
        return Ok(());
    };
    let path = PythonTextRef::from_owned(&reference.path)
        .scalar_text()
        .ok_or_else(|| io::Error::other("POOL_IMAGE_FIXED_REFERENCE_PATH"))?;
    let raw = serde_json::to_vec(&serde_json::json!({
        "version":1,"purpose":"worker-pool-image-reference-v1",
        "manifest":{"path":path,"sha256":reference.sha256.as_str()}
    }))?;
    super::manifest::write(
        &package.join("share/reverie/worker-pool-images-reference.json"),
        &raw,
    )
}
