//! Preserve the worker's Path(root)/SID mkdir phase before resolving the root
//! for the existing nofollow socket owner. Resolution is path data, not custody.
use super::{OfficeError, Result};
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::{ids::ProfileSessionId, posix_path::PosixPath};
use std::{
    fs, io,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

pub(super) fn prepare(root: &MetadataText, session: &ProfileSessionId) -> Result<PathBuf> {
    let root = PosixPath::try_new(root.codepoints()).map_err(|_| OfficeError::Refused)?;
    let sid = PosixPath::from_scalar_text(session.as_str());
    let raw = crate::native::python_path(&root.join(&sid).codepoints())?;
    // Match Path.mkdir(parents=True, exist_ok=True) before resolving '..': a
    // missing component is created and a regular-file/.. traversal must fail.
    // These directories remain after later refusal, as in the source owner.
    mkdir(&raw)?;
    if fs::symlink_metadata(&raw)?.file_type().is_symlink() {
        return Err(OfficeError::Refused);
    }
    // Never resolve the final SID itself: its symlink refusal must survive.
    let resolved = crate::native::resolve_optional_text(&root.codepoints())?;
    Ok(crate::native::python_path(
        &resolved.join(&sid).codepoints(),
    )?)
}

fn mkdir(directory: &Path) -> io::Result<()> {
    let initial = fs::DirBuilder::new().mode(0o700).create(directory);
    if initial
        .as_ref()
        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
    {
        // Path.mkdir supplies its mode only to the final directory. Recursive
        // parents use their normal default0777, still subject to the umask.
        let parent = directory.parent().ok_or(io::ErrorKind::NotFound)?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o777)
            .create(parent)?;
        finish_mkdir(
            directory,
            fs::DirBuilder::new().mode(0o700).create(directory),
        )
    } else {
        finish_mkdir(directory, initial)
    }
}
fn finish_mkdir(directory: &Path, result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(_) if directory.is_dir() => Ok(()),
        other => other,
    }
}
