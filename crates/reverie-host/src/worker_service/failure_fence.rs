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
    assert_pending_permits_startup(&path.with_file_name("pending"))?;
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
    let closed = native::close(state).map_err(std::io::Error::other);
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

fn assert_pending_permits_startup(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(m) => m,
    };
    need(
        metadata.is_file()
            && metadata.uid() == nix::unistd::geteuid().as_raw()
            && metadata.mode() & 0o077 == 0
            && metadata.nlink() == 1,
        "NATIVE_SERVICE_PENDING_CUSTODY",
    )?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let body = (|| {
        use std::io::Read;
        let mut raw = Vec::new();
        (&file).take(256).read_to_end(&mut raw)?;
        need(
            raw == pending_bytes(&WorkerServiceAction::Start),
            "NATIVE_SERVICE_UNSETTLED_INSTALL_OR_STOP",
        )
    })();
    finalized(
        body,
        native::close(file).map_err(|e| WorkerServiceError::Io(std::io::Error::other(e))),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_install_pending_refuses_direct_broker_start_but_start_command_does_not_deadlock() {
        let root = std::env::temp_dir().join(format!(
            "native-pending-{}-{}",
            std::process::id(),
            crate::resource_facts::fresh_owner_nonce().unwrap().as_str()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let path = root.join("pending");
        for action in [
            WorkerServiceAction::Install,
            WorkerServiceAction::Stop,
            WorkerServiceAction::Start,
        ] {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .unwrap();
            file.write_all(pending_bytes(&action)).unwrap();
            file.sync_all().unwrap();
            native::close(file).unwrap();
            assert_eq!(
                assert_pending_permits_startup(&path).is_ok(),
                matches!(action, WorkerServiceAction::Start)
            );
            fs::remove_file(&path).unwrap();
        }
        fs::remove_dir(root).unwrap();
    }
}
