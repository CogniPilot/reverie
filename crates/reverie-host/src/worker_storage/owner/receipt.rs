//! Existing launch read_text/exit.exists phase through the actual resource.
//! Leaf aliases remain source-compatible; no write or completion is inferred.
use super::*;
use reverie_contracts::broker_laptop::LaunchRuntimeData;
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::OpenOptionsExt,
};

pub struct LaunchReceiptObservation {
    exit: PosixPath,
    exists: bool,
}
impl LaunchReceiptObservation {
    pub fn exit_path_data(&self) -> &PosixPath {
        &self.exit
    }
    /// This single exists observation is neither is_file nor an exit result.
    pub fn exists(&self) -> bool {
        self.exists
    }
}
impl LaunchStorage {
    pub fn observe_launch_receipt(&self) -> OwnerResult<LaunchReceiptObservation> {
        self.check_resource_current()?;
        let result = self.read_launch_receipt();
        let current = self.check_resource_current().map(|_| ());
        finalized(result, current)
    }
    fn read_launch_receipt(&self) -> OwnerResult<LaunchReceiptObservation> {
        let config = ResourceIdentitySettings::capture_worker_config(&self.source)
            .map_err(StorageOwnerError::Settings)?;
        let root = PosixPath::try_new(config.state_root().codepoints())
            .map_err(|_| StorageOwnerError::Refused("WORKER_RUNTIME_PATH"))?;
        let runtime = root
            .join(&PosixPath::from_scalar_text(self.paths.session().as_str()))
            .join(&PosixPath::from_scalar_text("runtime.json"));
        let runtime =
            native::python_path(&runtime.codepoints()).map_err(StorageOwnerError::Path)?;
        let raw = read_text(&runtime)?;
        let data = LaunchRuntimeData::decode_read_text(&raw).map_err(StorageOwnerError::Runtime)?;
        let exit = PosixPath::try_new(data.exit().codepoints())
            .map_err(|_| StorageOwnerError::Refused("WORKER_RUNTIME_PATH"))?;
        // Preserve pathlib's absolute right operand and '..' semantics. The
        // result remains read-side DATA; it never selects a native effect.
        let home = PosixPath::try_new(&native::python_text(self.paths.home()))
            .map_err(|_| StorageOwnerError::Refused("WORKER_RUNTIME_PATH"))?;
        let exit = home
            .join(&PosixPath::from_scalar_text(".reverie-launch"))
            .join(&exit);
        let exists = exists(&exit)?;
        Ok(LaunchReceiptObservation { exit, exists })
    }
}
fn read_text(path: &Path) -> OwnerResult<Vec<u8>> {
    // Like the source, this trusted private runtime leaf has no new JSON byte
    // limit. Follow its existing symlink/hardlink semantics and close the FD
    // explicitly even on a read error. This is not a hard kernel-I/O deadline.
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(StorageOwnerError::Path)?;
    let mut raw = Vec::new();
    let read = file
        .read_to_end(&mut raw)
        .map(|_| raw)
        .map_err(StorageOwnerError::Path);
    let closed = native::close(file).map_err(|e| StorageOwnerError::Storage(e.into()));
    finalized(read, closed)
}
fn exists(path: &PosixPath) -> OwnerResult<bool> {
    let path = match native::python_path(&path.codepoints()) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => return Ok(false),
        Err(error) => return Err(StorageOwnerError::Path(error)),
    };
    match fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error)
            if error.kind() == std::io::ErrorKind::InvalidInput
                || matches!(
                    error.raw_os_error(),
                    Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP)
                ) =>
        {
            Ok(false)
        }
        Err(error) => Err(StorageOwnerError::Path(error)),
    }
}
fn finalized<T>(result: OwnerResult<T>, close: OwnerResult<()>) -> OwnerResult<T> {
    match (result, close) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(primary), Err(secondary)) => Err(StorageOwnerError::Finalized {
            primary: Box::new(primary),
            secondary: vec![secondary],
        }),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
    }
}
