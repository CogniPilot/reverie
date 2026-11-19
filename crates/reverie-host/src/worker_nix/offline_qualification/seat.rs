//! Resolve the existing employee store and its fixed preparation command.
use super::{ControlPin, Result, require_owner_uid};
use crate::{
    native,
    worker_storage::{self, StorageLockPaths},
};
use reverie_contracts::{
    storage_identity::MetadataText,
    worker_config,
    worker_nix::{NixConfiguration, NixPreparationArguments},
};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_store::storage_identity::{self, StoragePaths};
use std::{
    fs, io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

pub struct Seat {
    pub paths: StoragePaths,
    pub locks: StorageLockPaths,
    pub session_lock: PathBuf,
    pub helper: NixPreparationArguments,
}

/// Observe existing paths without acquiring either lease or creating storage.
/// The recheck also evaluates the normal session fence before effect admission.
pub fn inspect_seat(
    pin: ControlPin<'_>,
    session: &ProfileSessionId,
    employee: &ProfileEmployeeId,
    recheck_session_fence: bool,
) -> Result<Seat> {
    let uid = nix::unistd::getuid().as_raw();
    let raw = pin.read(uid)?;
    let config = NixConfiguration::capture(&worker_config::decode_offline_store(&raw)?);
    require_owner_uid(config.uid()?)?;
    let paths = if recheck_session_fence {
        let directory = super::super::session_directory(&config, session, false, &mut false)?;
        let observed = super::super::selection::check_fences(&config, session);
        super::super::finalized(observed, directory.close().map_err(Into::into))?
    } else {
        let identity = super::super::identity(&config)?;
        storage_identity::storage_paths(&identity, session)?
    };
    if paths.employee() != Some(employee) {
        return Err("current canonical employee store required".into());
    }
    let source = config.source();
    worker_storage::validate_storage(source, &paths)?;
    let locks = worker_storage::lock_paths(source, &paths)?;
    require_unfenced(locks.migration_fence())?;
    let session_lock = super::super::session_path(&config, session)?.join("nix.lock");
    if observe_lock(locks.lock(), uid)? == observe_lock(&session_lock, uid)? {
        return Err("distinct native lock inodes required".into());
    }
    let path = reverie_core::PythonText::try_new(native::python_text(paths.nix()))?;
    let helper =
        NixPreparationArguments::capture(&config, session, &MetadataText::from_python_text(path))?;
    Ok(Seat {
        paths,
        locks,
        session_lock,
        helper,
    })
}

fn require_unfenced(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err("employee maintenance/migration remains fenced".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn observe_lock(path: &Path, uid: u32) -> Result<(u64, u64)> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err("both existing native locks required".into());
    }
    Ok((metadata.dev(), metadata.ino()))
}
