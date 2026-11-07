//! Original raw worker mkdir: private final directory, normal default parents.
//! Callers retain their distinct namespace and symlink/owner policies.
use std::{fs, io, os::unix::fs::DirBuilderExt, path::Path};
pub(crate) fn create_worker_private(directory: &Path) -> io::Result<()> {
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
