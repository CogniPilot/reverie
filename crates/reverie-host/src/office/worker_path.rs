//! Preserve the worker's Path(root)/SID mkdir phase before resolving the root
//! for the existing nofollow socket owner. Resolution is path data, not custody.
use super::{OfficeError, Result};
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::{ids::ProfileSessionId, posix_path::PosixPath};
use std::{fs, path::PathBuf};

pub(super) fn prepare(root: &MetadataText, session: &ProfileSessionId) -> Result<PathBuf> {
    let root = PosixPath::try_new(root.codepoints()).map_err(|_| OfficeError::Refused)?;
    let sid = PosixPath::from_scalar_text(session.as_str());
    let raw = crate::native::python_path(&root.join(&sid).codepoints())?;
    // Match Path.mkdir(parents=True, exist_ok=True) before resolving '..': a
    // missing component is created and a regular-file/.. traversal must fail.
    // These directories remain after later refusal, as in the source owner.
    crate::native::worker_directory::create_worker_private(&raw)?;
    if fs::symlink_metadata(&raw)?.file_type().is_symlink() {
        return Err(OfficeError::Refused);
    }
    // Never resolve the final SID itself: its symlink refusal must survive.
    let resolved = crate::native::resolve_optional_text(&root.codepoints())?;
    Ok(crate::native::python_path(
        &resolved.join(&sid).codepoints(),
    )?)
}
