//! Fixed launch-wait observation. This strict metadata read intentionally does
//! not use allowed()'s alias-following text reader or storage eligibility gates.
use super::*;
use reverie_contracts::{
    storage_writers::{LaunchWaitBinding, launch_wait_binding},
    worker_intent::WorkerIntentConfiguration,
};

/// Trusted installing-service configuration selects the company file. The
/// returned comparison bytes are DATA, not a launch or employee permission.
pub fn read_launch_wait_binding(
    source: &EffectiveWorkerConfig,
    session: &ProfileSessionId,
) -> std::result::Result<Option<LaunchWaitBinding>, StorageOwnerError> {
    let settings = WorkerIntentConfiguration::new(source);
    let text = settings.company_file().map_err(StorageOwnerError::Intent)?;
    // Path(str) normalizes '.', repeated separators and trailing separators
    // before read_metadata's independent canonical/no-follow custody checks.
    let path = PosixPath::try_new(text.codepoints())
        .map_err(|_| StorageOwnerError::Path(std::io::ErrorKind::InvalidInput.into()))?;
    let path = native::python_path(&path.codepoints()).map_err(StorageOwnerError::Path)?;
    let uid = settings.uid().map_err(StorageOwnerError::Intent)?;
    let metadata =
        storage_identity::read_metadata(&path, uid, storage_identity::DEFAULT_METADATA_LIMIT)
            .map_err(StorageOwnerError::Identity)?;
    launch_wait_binding(&metadata, session).map_err(StorageOwnerError::Data)
}
