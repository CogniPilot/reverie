//! Compiler-selected package references. DATA only: no readiness,
//! source qualification, installation consent or runtime path selector.
use reverie_contracts::resource_actor::ArtifactReference;
use reverie_core::{PythonText, operations::JournalDigest};
use std::{
    io,
    path::{Component, Path},
};

pub fn compiled_pool_image_inputs_reference() -> io::Result<Option<ArtifactReference>> {
    fixed_reference(
        option_env!("REVERIE_FIXED_NATIVE_POOL_IMAGE_INPUTS_MANIFEST"),
        option_env!("REVERIE_FIXED_NATIVE_POOL_IMAGE_INPUTS_SHA256"),
    )
}

/// Previous package inputs are DATA only, selected by the trusted build.
pub fn compiled_previous_pool_image_inputs_reference() -> io::Result<Option<ArtifactReference>> {
    fixed_reference(
        option_env!("REVERIE_FIXED_PREVIOUS_WORKER_POOL_IMAGE_INPUTS_MANIFEST"),
        option_env!("REVERIE_FIXED_PREVIOUS_WORKER_POOL_IMAGE_INPUTS_SHA256"),
    )
}

fn fixed_reference(
    path: Option<&str>,
    digest: Option<&str>,
) -> io::Result<Option<ArtifactReference>> {
    match (path, digest) {
        (None, None) => Ok(None),
        (Some(path), Some(digest)) => {
            let parsed = Path::new(path);
            if !path.starts_with("/nix/store/")
                || path.contains("//")
                || path.contains('\0')
                || !path.ends_with("/share/reverie/worker-pool-image-inputs.json")
                || parsed
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
            {
                return Err(io::Error::other("POOL_IMAGE_FIXED_REFERENCE_PATH"));
            }
            let sha256 = JournalDigest::parse(digest)
                .map_err(|_| io::Error::other("POOL_IMAGE_FIXED_REFERENCE_DIGEST"))?;
            Ok(Some(ArtifactReference {
                path: PythonText::from_scalar_text(path),
                sha256,
            }))
        }
        _ => Err(io::Error::other("POOL_IMAGE_FIXED_REFERENCE_INCOMPLETE")),
    }
}
