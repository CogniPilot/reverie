//! Lifetime employee/session storage leases. This is neither engine-writer
//! exclusion nor admission/start authority. InstallingBroker must retain the
//! lease for the laptop lifetime and independently inspect actual writers.
//! See the module README for compatible inputs, failure custody and remaining
//! actual broker integration obligations.
mod error;
mod fs;
mod owner;
mod wait_binding;
mod writers;
pub use wait_binding::read_launch_wait_binding;
mod prepare;
pub use owner::{
    LaunchStorage, StorageAcquireFailure, StorageCloseFailure, StorageOwnerError,
    StorageOwnershipKind, StorageSelection,
};
mod temporary;
#[cfg(test)]
mod tests;
use crate::native;
use error::{Result, finalized, need, partial};
pub use error::{StorageError, StorageFault};
use fs::Directory;
use reverie_contracts::{
    resource_config::ResourceIdentitySettings, storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig, worker_storage::StorageConfiguration,
};
use reverie_core::{ids::ProfileSessionId, posix_path::PosixPath};
use reverie_store::storage_identity::{self, StorageIdentityConfig, StoragePaths};
use std::{
    ffi::OsString,
    fs::File,
    path::{Path, PathBuf},
};

struct Configuration {
    data: StorageConfiguration,
    identity: StorageIdentityConfig,
    settings: ResourceIdentitySettings,
}
impl Configuration {
    fn capture(source: &EffectiveWorkerConfig) -> Result<Self> {
        let data = StorageConfiguration::capture(source);
        let settings = data.identity_settings()?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        Ok(Self {
            data,
            identity,
            settings,
        })
    }
    fn uid(&self) -> u32 {
        self.settings.uid()
    }
    fn journal(&self) -> Result<PathBuf> {
        let path = PosixPath::try_new(self.settings.company_file().codepoints())
            .map_err(|_| StorageError::Refused(StorageFault::CanonicalPath))?;
        Ok(native::python_path(&path.codepoints())?.with_file_name("plan-moves.json"))
    }
    fn state(&self) -> Result<PathBuf> {
        canonical_text(self.settings.state_root())
    }
    fn scratch(&self) -> Result<PathBuf> {
        canonical_text(self.settings.scratch_root())
    }
    fn base(&self, create: bool, effects: &mut bool) -> Result<Directory> {
        let root = canonical_posix(self.settings.state_root())?;
        let scratch = canonical_posix(self.settings.scratch_root())?;
        need(!root.is_relative_to(&scratch), StorageFault::SharedState)?;
        for source in self.data.shared_sources()? {
            need(
                !root.is_relative_to(&canonical_posix(&source?)?),
                StorageFault::SharedState,
            )?;
        }
        directory(
            &native::python_path(&root.codepoints())?,
            self.uid(),
            create,
            effects,
        )
    }
    fn same_binding(&self, paths: &StoragePaths) -> Result<()> {
        need(
            storage_identity::storage_paths(&self.identity, paths.session())? == *paths,
            StorageFault::BindingChanged,
        )
    }
}
fn canonical_text(text: &MetadataText) -> Result<PathBuf> {
    Ok(native::python_path(&canonical_posix(text)?.codepoints())?)
}
fn canonical_posix(text: &MetadataText) -> Result<PosixPath> {
    let path = PosixPath::try_new(text.codepoints())
        .map_err(|_| StorageError::Refused(StorageFault::CanonicalPath))?;
    need(
        path.codepoints() == text.codepoints()
            && path.is_single_rooted()
            && !path.has_parent_component(),
        StorageFault::CanonicalPath,
    )?;
    need(
        native::resolve_optional_text(text.codepoints())? == path,
        StorageFault::CanonicalPath,
    )?;
    Ok(path)
}
fn directory(path: &Path, uid: u32, create: bool, effects: &mut bool) -> Result<Directory> {
    if create {
        Directory::ensure(path, uid, effects)
    } else {
        Directory::open(path, uid)
    }
}

/// Paths are DATA, including the fixed migration fence. Reading them does not
/// acquire, reserve, or initialize storage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageLockPaths {
    lock: PathBuf,
    fence: PathBuf,
}
impl StorageLockPaths {
    pub fn lock(&self) -> &Path {
        &self.lock
    }
    pub fn migration_fence(&self) -> &Path {
        &self.fence
    }
}
pub fn lock_paths(
    source: &EffectiveWorkerConfig,
    paths: &StoragePaths,
) -> Result<StorageLockPaths> {
    let config = Configuration::capture(source)?;
    let state = config.state()?;
    let parent = lock_directory(&config, false, &mut false)?;
    let result = StorageLockPaths {
        lock: state
            .join("storage-locks")
            .join(format!("{}.lock", paths.key())),
        fence: state
            .join("storage-locks")
            .join(format!("{}.migration.json", paths.key())),
    };
    finalized(Ok(result), parent.close())
}
fn lock_directory(config: &Configuration, create: bool, effects: &mut bool) -> Result<Directory> {
    let base = config.base(create, effects)?;
    let result = (|| {
        directory(
            &config.state()?.join("storage-locks"),
            config.uid(),
            create,
            effects,
        )
    })();
    match (result, base.close()) {
        (Ok(child), Ok(())) => Ok(child),
        (Ok(child), Err(error)) => finalized(Err(error), child.close()),
        (Err(error), closed) => finalized(Err(error), closed),
    }
}

/// Non-cloneable resource owner, held through laptop lifetime. Paths and the
/// lease itself never mint a Gate permit, running-container proof or grant.
pub struct StorageLease {
    config: Configuration,
    paths: StoragePaths,
    directory: Option<Directory>,
    file: Option<File>,
    lock_name: OsString,
}
impl StorageLease {
    pub fn acquire_launch(
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<Self> {
        Self::acquire(source, session, false)
    }
    /// The named offline migration path skips only the existing migration fence;
    /// it still acquires the identical exclusive employee/session lock.
    pub fn acquire_migration(
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<Self> {
        Self::acquire(source, session, true)
    }
    fn acquire(
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
        migration: bool,
    ) -> Result<Self> {
        let config = Configuration::capture(source)?;
        let paths = storage_identity::storage_paths(&config.identity, session)?;
        let mut effects = false;
        let result = Self::acquire_paths(config, paths, migration, &mut effects);
        partial(result, effects)
    }
    fn acquire_paths(
        config: Configuration,
        paths: StoragePaths,
        migration: bool,
        effects: &mut bool,
    ) -> Result<Self> {
        let parent = lock_directory(&config, true, effects)?;
        let lock_name = OsString::from(format!("{}.lock", paths.key()));
        let file = match parent.lock_file(&lock_name, effects) {
            Ok(file) => file,
            Err(error) => return finalized(Err(error), parent.close()),
        };
        let result = (|| {
            parent.file_current(&file, &lock_name)?;
            match file.try_lock() {
                Ok(()) => {}
                Err(std::fs::TryLockError::WouldBlock) => {
                    return Err(StorageError::Refused(StorageFault::LeaseBusy));
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
            }
            let fence = config
                .state()?
                .join("storage-locks")
                .join(format!("{}.migration.json", paths.key()));
            need(
                migration || !fs::present(&fence)?,
                StorageFault::MigrationFence,
            )?;
            config.same_binding(&paths)?;
            parent.file_current(&file, &lock_name)
        })();
        if let Err(error) = result {
            return finalized(finalized(Err(error), fs::close(file)), parent.close());
        }
        Ok(Self {
            config,
            paths,
            directory: Some(parent),
            file: Some(file),
            lock_name,
        })
    }
    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }
    fn assert_current(&self) -> Result<()> {
        let parent = self
            .directory
            .as_ref()
            .ok_or(StorageError::Refused(StorageFault::ClosedLease))?;
        let file = self
            .file
            .as_ref()
            .ok_or(StorageError::Refused(StorageFault::ClosedLease))?;
        parent.file_current(file, &self.lock_name)
    }
    pub fn prepare_storage(&mut self) -> Result<()> {
        self.assert_current()?;
        let mut effects = false;
        let result = prepare::prepare(&self.config, &self.paths, &mut effects);
        partial(finalized(result, self.assert_current()), effects)
    }
    pub fn record_storage_binding(&mut self) -> Result<()> {
        if self.paths.employee().is_none() {
            return Ok(());
        }
        self.assert_current()?;
        let mut effects = false;
        let result = prepare::record(&self.config, &self.paths, &mut effects);
        partial(finalized(result, self.assert_current()), effects)
    }
    /// Checked consumption; Drop's best effort is not an acknowledgement.
    pub fn close(mut self) -> Result<()> {
        let checked = self.assert_current();
        let closed = self.file.take().map_or(Ok(()), fs::close);
        let parent = self.directory.take().map_or(Ok(()), Directory::close);
        finalized(finalized(checked, closed), parent)
    }
}
/// Read-only restart data validation. It does not reselect current employees,
/// initialize missing paths, acquire a lease or prove execution eligibility.
pub fn validate_storage(source: &EffectiveWorkerConfig, paths: &StoragePaths) -> Result<()> {
    let config = Configuration::capture(source)?;
    prepare::validate(&config, paths)
}
