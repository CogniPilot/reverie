use super::*;
use crate::worker_storage::{self, fs::Directory};
use reverie_contracts::worker_nix::{NixMigrationMarker, validate_rollback_text};
use reverie_store::storage_identity::StoragePaths;

fn present(path: &std::path::Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e)
            if e.kind() == std::io::ErrorKind::NotFound
                || matches!(
                    e.raw_os_error(),
                    Some(libc::ENOTDIR | libc::ELOOP | libc::EBADF)
                ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
}
pub(super) fn check_fences(
    config: &NixConfiguration,
    session: &ProfileSessionId,
) -> Result<StoragePaths> {
    let fence = session_path(config, session)?.join("nix-migration.json");
    let identity = identity(config)?;
    let paths = if present(&fence)? {
        let marker = storage_identity::read_metadata(&fence, config.uid()?, 65536)?;
        let marker = NixMigrationMarker::capture(&marker, session)?;
        let paths = storage_identity::storage_paths(&identity, session)?;
        need(
            paths
                .employee()
                .is_some_and(|employee| marker.matches_employee(employee)),
            NixFault::MigrationFence,
        )?;
        worker_storage::validate_storage(config.source(), &paths)?;
        paths
    } else {
        storage_identity::storage_paths(&identity, session)?
    };
    if paths.employee().is_some() {
        let locks = worker_storage::lock_paths(config.source(), &paths)?;
        need(!present(locks.migration_fence())?, NixFault::EmployeeFence)?;
        worker_storage::validate_storage(config.source(), &paths)?;
    }
    Ok(paths)
}
pub(super) fn store_path(config: &NixConfiguration, session: &ProfileSessionId) -> Result<PathBuf> {
    Ok(native::python_path(
        &store_path_text(config, session)?.codepoints(),
    )?)
}
fn child(root: PosixPath, name: &str) -> PosixPath {
    root.join(&PosixPath::from_scalar_text(name))
}
pub(super) fn store_path_text(
    config: &NixConfiguration,
    session: &ProfileSessionId,
) -> Result<PosixPath> {
    let paths = storage_identity::storage_paths(&identity(config)?, session)?;
    if let Some(employee) = paths.employee() {
        return Ok(child(
            child(
                child(lexical(&config.state_root()?)?, "employees"),
                employee.as_str(),
            ),
            "nix",
        ));
    }
    let directory = session_path(config, session)?;
    let rollback = directory.join("nix-rollback.json");
    if present(&rollback)? {
        let bytes = native::read_nix_rollback(&rollback, config.uid()?)?;
        validate_rollback_text(&bytes, session)?;
        return Ok(child(
            child(lexical(&config.scratch_root()?)?, session.as_str()),
            "nix",
        ));
    }
    Ok(child(
        child(lexical(&config.state_root()?)?, session.as_str()),
        "nix",
    ))
}
pub(super) fn private_store(
    config: &NixConfiguration,
    session: &ProfileSessionId,
    effects: &mut bool,
) -> Result<PathBuf> {
    let directory = session_directory(config, session, effects)?;
    let result = (|| {
        let paths = check_fences(config, session)?;
        let path_text = store_path_text(config, session)?;
        let path = native::python_path(&path_text.codepoints())?;
        if paths.employee().is_some() {
            worker_storage::validate_storage(config.source(), &paths)?;
        }
        let legacy_text = child(
            child(lexical(&config.scratch_root()?)?, session.as_str()),
            "nix",
        );
        let legacy = native::python_path(&legacy_text.codepoints())?;
        let exists = path.try_exists()?;
        if path_text == legacy_text {
            need(exists, NixFault::RollbackMissing)?;
        } else {
            need(exists || !present(&legacy)?, NixFault::LegacyStore)?;
        }
        Directory::nix_directory(&path, config.uid()?, false, effects)?.close()?;
        Ok(path)
    })();
    finalized(result, directory.close().map_err(Into::into))
}
