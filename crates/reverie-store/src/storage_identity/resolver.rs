use super::{DEFAULT_METADATA_LIMIT, IdentityFault, Result, canonical, need, read_metadata};
use reverie_contracts::storage_identity::{CompanyRecords, CurrentEmployee, MetadataText};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Paths selected by the trusted native caller, not a request's employee/path.
#[derive(Clone, Debug)]
pub struct StorageIdentityConfig {
    company_file: PathBuf,
    state_root: PathBuf,
    scratch_root: PathBuf,
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
            company_file: canonical(&company_file)?,
            state_root: canonical(&state_root)?,
            scratch_root: canonical(&scratch_root)?,
            uid,
        })
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
    Ok(
        read_metadata(&config.company_file, config.uid, DEFAULT_METADATA_LIMIT)?
            .company_records()?,
    )
}
pub fn storage_paths(
    config: &StorageIdentityConfig,
    session: &ProfileSessionId,
) -> Result<StoragePaths> {
    let records = company_records(config)?;
    let mut selected = records.by_session(session).cloned();
    let indexed = config
        .state_root
        .join(session.as_str())
        .join("storage-owner.json");
    if present(&indexed)? {
        let binding = read_metadata(&indexed, config.uid, 65536)?.storage_owner(session)?;
        let indexed = records.by_binding(binding.employee(), binding.owner());
        need(
            indexed.is_some() && (selected.is_none() || selected.as_ref() == indexed),
            IdentityFault::StoredBindingConflict,
        )?;
        selected = indexed.cloned();
    }
    let journal = config.company_file.with_file_name("plan-moves.json");
    if selected.is_none() && present(&journal)? {
        selected = read_metadata(&journal, config.uid, 1024 * 1024)?
            .historical_employee(&records, session)?;
    }
    let base = canonical(&config.state_root)?;
    let scratch = canonical(&config.scratch_root)?;
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
    Ok(
        read_metadata(&config.company_file, config.uid, DEFAULT_METADATA_LIMIT)?
            .current_start_allowed(employee, paths.session(), paths.owner())?,
    )
}
pub fn current_employee(
    config: &StorageIdentityConfig,
    session: &ProfileSessionId,
) -> Result<Option<CurrentEmployee>> {
    let paths = storage_paths(config, session)?;
    let Some(employee) = paths.employee() else {
        return Ok(None);
    };
    let first = read_metadata(&config.company_file, config.uid, DEFAULT_METADATA_LIMIT)?
        .current_employee(employee, session, paths.owner())?;
    #[cfg(test)]
    super::tests::hit(super::tests::Point::CurrentSelected, &config.company_file)?;
    need(
        storage_paths(config, session)? == paths,
        IdentityFault::CurrentBindingChanged,
    )?;
    let second = read_metadata(&config.company_file, config.uid, DEFAULT_METADATA_LIMIT)?
        .current_employee(employee, session, paths.owner())?;
    need(second == first, IdentityFault::CurrentBindingChanged)?;
    Ok(first)
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ENOTDIR) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
