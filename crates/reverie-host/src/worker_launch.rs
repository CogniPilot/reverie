//! Readonly account/hostname and actual create-argument observations. Captured
//! runtime provenance is retained without granting API or start permission.
mod observed;
use crate::{native, rootless};
pub(crate) use observed::ObservedPlanIdentity;
pub use observed::{
    CreateObservationError, ExistingCaptureFailure, ExistingLaptopInspection,
    ExistingObservationError, ExistingPaneState, ExistingProcessIncarnation, ObservedCreatePlan,
    observe_create_arguments,
};
use reverie_contracts::{
    rootless::RootlessConfig,
    storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig,
    worker_launch::{self, LaunchDataError, LaunchSettings},
};
use reverie_core::worker_launch::{AccountSelection, WorkerDirectory, WorkerEnvironment};
use reverie_store::storage_identity::{self, StoragePaths};
use std::{fmt, fs, io, os::unix::ffi::OsStrExt};
#[cfg(test)]
mod tests;

#[derive(Debug)]
pub enum LaunchHostError {
    Data(LaunchDataError),
    Io(io::Error),
    Rootless(rootless::RootlessHostError),
    Identity(storage_identity::IdentityError),
    AccountUnavailable,
}
impl fmt::Display for LaunchHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(match self {
            Self::Data(_) => "LAUNCH_DATA",
            Self::Io(_) => "LAUNCH_PATH_IO",
            Self::Rootless(_) => "LAUNCH_ROOTLESS",
            Self::Identity(_) => "LAUNCH_METADATA",
            Self::AccountUnavailable => "LAUNCH_ACCOUNT_UNAVAILABLE",
        })
    }
}
impl std::error::Error for LaunchHostError {}
impl From<LaunchDataError> for LaunchHostError {
    fn from(value: LaunchDataError) -> Self {
        Self::Data(value)
    }
}
impl From<io::Error> for LaunchHostError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<rootless::RootlessHostError> for LaunchHostError {
    fn from(value: rootless::RootlessHostError) -> Self {
        Self::Rootless(value)
    }
}
impl From<storage_identity::IdentityError> for LaunchHostError {
    fn from(value: storage_identity::IdentityError) -> Self {
        Self::Identity(value)
    }
}
type Result<T> = std::result::Result<T, LaunchHostError>;

/// The selected accounts are resolved freshly, in fixed key order, before the
/// rootless account policy observation. Ancestor/leaf symlinks are allowed when
/// their strict resolved Python path remains inside the resolved company root.
pub fn account_mounts(
    config: &EffectiveWorkerConfig,
    environment: &WorkerEnvironment,
) -> Result<Vec<MetadataText>> {
    let mut entries: Vec<(MetadataText, MetadataText)> = Vec::new();
    for key in ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME"] {
        let Some(value) = environment.get(key).filter(|value| !value.is_empty()) else {
            continue;
        };
        let selected = AccountSelection::try_new(value.to_vec()).map_err(LaunchDataError::from)?;
        let settings = LaunchSettings::capture(config)?;
        let root = native::resolve_optional_text(settings.company_root().codepoints())?;
        let source = native::resolve_strict_text(&root.join(selected.relative()).codepoints())?;
        if !source.is_relative_to(&root)
            || !fs::metadata(native::python_path(&source.codepoints())?)
                .is_ok_and(|info| info.is_dir())
        {
            return Err(LaunchHostError::AccountUnavailable);
        }
        #[cfg(test)]
        tests::account_resolved();
        let destination = worker_launch::account_destination(&selected);
        let source = worker_launch::resolved_account_source(&source);
        // Duplicate destinations are observed again, then replaced in place;
        // dict insertion order remains the first occurrence's position.
        if let Some((_, old)) = entries.iter_mut().find(|(name, _)| *name == destination) {
            *old = source;
        } else {
            entries.push((destination, source));
        }
    }
    let rootless =
        RootlessConfig::capture(config.clone()).map_err(rootless::RootlessHostError::from)?;
    rootless::require_rootless_accounts(
        &rootless,
        &entries
            .iter()
            .map(|(target, _)| target.clone())
            .collect::<Vec<_>>(),
    )?;
    Ok(worker_launch::account_mount_arguments(&entries))
}
/// A fresh ID+owner-only metadata observation. Historical storage is allowed;
/// this is a human hostname label, not current-employee authority.
pub fn employee_hostname(
    config: &EffectiveWorkerConfig,
    storage: &StoragePaths,
) -> Result<Option<String>> {
    let Some(employee) = storage.employee() else {
        return Ok(None);
    };
    let settings = LaunchSettings::capture(config)?;
    let path = native::python_path(settings.company_file().codepoints())?;
    let company = storage_identity::read_metadata(
        &path,
        settings.uid(),
        storage_identity::DEFAULT_METADATA_LIMIT,
    )?;
    Ok(Some(worker_launch::employee_hostname(
        &company,
        employee,
        storage.owner(),
    )?))
}
/// Raw cwd bytes are fsencoded before hashing, without lexical normalization.
pub fn temporary_environment(directory: &WorkerDirectory) -> Result<Vec<(String, String)>> {
    let path = native::python_path(directory.codepoints())?;
    Ok(worker_launch::temporary_environment(Some(
        path.as_os_str().as_bytes(),
    )))
}
/// Convert the exact supplied storage paths to lossless argv text; this does
/// not re-resolve or claim custody of those paths.
pub fn storage_argument_paths(storage: &StoragePaths) -> Result<(MetadataText, MetadataText)> {
    let home = native::python_text(storage.home());
    let scratch = native::python_text(storage.scratch());
    Ok((
        worker_launch::storage_path_text(&home)?,
        worker_launch::storage_path_text(&scratch)?,
    ))
}
