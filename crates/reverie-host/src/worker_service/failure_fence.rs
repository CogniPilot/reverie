//! An unresolved native broker process outcome cannot become a clean new
//! startup merely because the OS closed its descriptors. No automatic clear.
use super::*;
pub(super) fn path(source: &Path) -> Result<PathBuf> {
    let home = native::python_path(&native::home_directory(None)?)?;
    let root = home.join("reverie");
    need(
        source.is_absolute() && source.starts_with(&root),
        "NATIVE_SERVICE_INSTANCE_SOURCE_REQUIRED",
    )?;
    private(source, false)?;
    Ok(root.join("worker-pool/service/native-failure"))
}
pub fn assert_no_service_failure(source: &Path) -> Result<()> {
    let path = path(source)?;
    if fs::symlink_metadata(path.with_file_name("native-running")).is_ok() {
        return Err(WorkerServiceError::Refused(
            "NATIVE_SERVICE_RUNNING_OR_UNSETTLED_REQUIRES_RECOVERY",
        ));
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(WorkerServiceError::Refused(
            "NATIVE_SERVICE_PREVIOUS_FAILURE_REQUIRES_RECOVERY",
        )),
    }
}
pub fn record_service_failure(source: &Path) -> Result<()> {
    let target = path(source)?;
    let folder = target.parent().expect("fixed failure parent");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(folder)?;
    private(folder, true)?;
    let mut state = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&target)?;
    let written = state
        .write_all(b"NATIVE_BROKER_UNSETTLED_ORIGINAL_FAILURE_V1\n")
        .and_then(|()| state.sync_all());
    let closed = native::close(state).map_err(|e| std::io::Error::other(e));
    finalized(written.map_err(Into::into), closed.map_err(Into::into))?;
    let parent = native::open_at(
        libc::AT_FDCWD,
        folder.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    finalized(
        parent.sync_all().map_err(Into::into),
        native::close(parent).map_err(|e| WorkerServiceError::Io(std::io::Error::other(e))),
    )
}
