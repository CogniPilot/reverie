use super::input_path::InputPath;
use super::{DEFAULT_METADATA_LIMIT, IdentityFault, Result, canonical, need, read_metadata};
use reverie_contracts::storage_identity::{CompanyRecords, CurrentEmployee, MetadataText};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
mod provider;
pub use provider::ProviderRuntimeObservation;

/// Paths selected by the trusted native caller, not a request's employee/path.
#[derive(Clone, Debug)]
pub struct StorageIdentityConfig {
    company_file: InputPath,
    state_root: InputPath,
    scratch_root: InputPath,
    uid: u32,
}
impl StorageIdentityConfig {
    pub fn try_new(
        company_file: PathBuf,
        state_root: PathBuf,
        scratch_root: PathBuf,
        uid: u32,
    ) -> Result<Self> {
        Ok(Self {
            company_file: InputPath::Native(canonical(&company_file)?),
            state_root: InputPath::Native(canonical(&state_root)?),
            scratch_root: InputPath::Native(canonical(&scratch_root)?),
            uid,
        })
    }
    /// Same captured worker DATA only, for the original lazy selection phases.
    /// This makes no encoding/canonicality/custody assertion; those checks run
    /// at each actual resolver/read operation. Strict try_new is unchanged.
    pub fn capture_worker_settings(
        settings: &reverie_contracts::resource_config::ResourceIdentitySettings,
    ) -> Self {
        Self {
            company_file: InputPath::WorkerText(settings.company_file().clone()),
            state_root: InputPath::WorkerText(settings.state_root().clone()),
            scratch_root: InputPath::WorkerText(settings.scratch_root().clone()),
            uid: settings.uid(),
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageKind {
    Employee,
    Session,
}
#[derive(Clone, Debug, Eq, PartialEq)]
enum Identity {
    Employee(ProfileEmployeeId),
    Session(ProfileSessionId),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoragePaths {
    identity: Identity,
    root: PathBuf,
    home: PathBuf,
    nix: PathBuf,
    scratch: PathBuf,
    session: ProfileSessionId,
    owner: Option<MetadataText>,
}
impl StoragePaths {
    pub fn kind(&self) -> StorageKind {
        match self.identity {
            Identity::Employee(_) => StorageKind::Employee,
            Identity::Session(_) => StorageKind::Session,
        }
    }
    pub fn identity(&self) -> &str {
        match &self.identity {
            Identity::Employee(value) => value.as_str(),
            Identity::Session(value) => value.as_str(),
        }
    }
    pub fn employee(&self) -> Option<&ProfileEmployeeId> {
        if let Identity::Employee(value) = &self.identity {
            Some(value)
        } else {
            None
        }
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn owner(&self) -> &Option<MetadataText> {
        &self.owner
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn home(&self) -> &Path {
        &self.home
    }
    pub fn nix(&self) -> &Path {
        &self.nix
    }
    pub fn scratch(&self) -> &Path {
        &self.scratch
    }
    pub fn key(&self) -> String {
        format!(
            "{}-{}",
            if self.kind() == StorageKind::Employee {
                "employee"
            } else {
                "session"
            },
            self.identity()
        )
    }
}
pub fn company_records(config: &StorageIdentityConfig) -> Result<CompanyRecords> {
    Ok(read_company_metadata(config)?.company_records()?)
}
/// Original company metadata DATA, for purpose-specific selection order. This
/// is not a globally validated registry, selected employee or owner grant.
pub fn read_company_metadata(
    config: &StorageIdentityConfig,
) -> Result<reverie_contracts::storage_identity::Metadata> {
    read_metadata(
        &config.company_file.raw()?,
        config.uid,
        DEFAULT_METADATA_LIMIT,
    )
}
pub fn storage_paths(
    config: &StorageIdentityConfig,
    session: &ProfileSessionId,
) -> Result<StoragePaths> {
    let records = company_records(config)?;
    let mut selected = records.by_session(session).cloned();
    let indexed = match config.state_root.pathlike() {
        Ok(path) => Some(path.join(session.as_str()).join("storage-owner.json")),
        // pathlib.exists/is_symlink treat an unencodable Python path as
        // absent. Canonical(raw stateRoot) still refuses at its later phase.
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(indexed) = indexed
        && present(&indexed)?
    {
        let binding = read_metadata(&indexed, config.uid, 65536)?.storage_owner(session)?;
        let indexed = records.by_binding(binding.employee(), binding.owner());
        need(
            indexed.is_some() && (selected.is_none() || selected.as_ref() == indexed),
            IdentityFault::StoredBindingConflict,
        )?;
        selected = indexed.cloned();
    }
    let journal = config
        .company_file
        .pathlike()?
        .with_file_name("plan-moves.json");
    if selected.is_none() && present(&journal)? {
        selected = read_metadata(&journal, config.uid, 1024 * 1024)?
            .historical_employee(&records, session)?;
    }
    let base = canonical(&config.state_root.raw()?)?;
    let scratch = canonical(&config.scratch_root.raw()?)?;
    let (identity, root, scratch, owner) = match selected {
        Some(row) => {
            let employee = row.canonical_identity()?;
            let root = base.join("employees").join(employee.as_str());
            let scratch = scratch.join("employees").join(employee.as_str());
            (
                Identity::Employee(employee),
                root,
                scratch,
                row.owner().clone(),
            )
        }
        None => (
            Identity::Session(session.clone()),
            base.join(session.as_str()),
            scratch.join(session.as_str()),
            None,
        ),
    };
    Ok(StoragePaths {
        identity,
        home: root.join("home"),
        nix: root.join("nix"),
        root,
        scratch,
        session: session.clone(),
        owner,
    })
}
pub fn storage_start_allowed(config: &StorageIdentityConfig, paths: &StoragePaths) -> Result<bool> {
    if storage_paths(config, paths.session())? != *paths {
        return Ok(false);
    }
    let Some(employee) = paths.employee() else {
        return Ok(true);
    };
    Ok(read_metadata(
        &config.company_file.raw()?,
        config.uid,
        DEFAULT_METADATA_LIMIT,
    )?
    .current_start_allowed(employee, paths.session(), paths.owner())?)
}
pub fn current_employee(
    config: &StorageIdentityConfig,
    session: &ProfileSessionId,
) -> Result<Option<CurrentEmployee>> {
    let paths = storage_paths(config, session)?;
    let Some(employee) = paths.employee() else {
        return Ok(None);
    };
    let company = config.company_file.raw()?;
    let first = read_metadata(&company, config.uid, DEFAULT_METADATA_LIMIT)?.current_employee(
        employee,
        session,
        paths.owner(),
    )?;
    #[cfg(test)]
    super::tests::hit(super::tests::Point::CurrentSelected, &company)?;
    need(
        storage_paths(config, session)? == paths,
        IdentityFault::CurrentBindingChanged,
    )?;
    let second = read_metadata(&company, config.uid, DEFAULT_METADATA_LIMIT)?.current_employee(
        employee,
        session,
        paths.owner(),
    )?;
    need(second == first, IdentityFault::CurrentBindingChanged)?;
    Ok(first)
}
fn present(path: &Path) -> Result<bool> {
    // Python's Path lookup catches its embedded-NUL ValueError as absence;
    // this is not a metadata-read or canonical-path acceptance.
    if path.as_os_str().as_bytes().contains(&0) {
        return Ok(false);
    }
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || matches!(
                    error.raw_os_error(),
                    Some(libc::ENOTDIR | libc::EBADF | libc::ELOOP)
                ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
