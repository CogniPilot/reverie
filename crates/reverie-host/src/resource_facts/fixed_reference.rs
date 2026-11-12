//! Compiler-selected original factory reference only. No runtime path fallback,
//! website/OS permission, facts installation or process authority is supplied.
use reverie_contracts::resource_actor::ArtifactReference;
use reverie_core::{PythonText, operations::JournalDigest};
use std::{
    io,
    path::{Component, Path},
};

pub fn compiled_actor_image_provenance_reference() -> io::Result<Option<ArtifactReference>> {
    match (
        option_env!("REVERIE_FIXED_NATIVE_ACTOR_IMAGE_PROVENANCE_MANIFEST"),
        option_env!("REVERIE_FIXED_NATIVE_ACTOR_IMAGE_PROVENANCE_SHA256"),
    ) {
        (None, None) => Ok(None),
        (Some(path), Some(digest)) => {
            if !path.starts_with("/nix/store/")
                || path.contains("//")
                || path.contains('\0')
                || !path.ends_with("/share/reverie/website-image.json")
                || Path::new(path)
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
            {
                return Err(io::Error::other("ACTOR_IMAGE_FIXED_REFERENCE_PATH"));
            }
            let sha256 = JournalDigest::parse(digest)
                .map_err(|_| io::Error::other("ACTOR_IMAGE_FIXED_REFERENCE_DIGEST"))?;
            Ok(Some(ArtifactReference {
                path: PythonText::from_scalar_text(path),
                sha256,
            }))
        }
        _ => Err(io::Error::other("ACTOR_IMAGE_FIXED_REFERENCE_INCOMPLETE")),
    }
}
