//! Private Nix store resource ownership. A held lock/path is not an owner
//! grant, image proof, engine capability or admitted laptop start permit.
mod error;
pub mod guest;
mod selection;
mod workflow;
pub(crate) use workflow::Workflows;
pub use workflow::{
    NixDisposition, NixImageQualification, NixProgress, NixReclaimFailure, NixRetainFailure,
    NixReturned, NixWorkflow,
};
#[cfg(test)]
mod tests;
use crate::{native, worker_storage::fs::Directory};
pub use error::{NixError, NixFault};
use error::{Result, finalized, need, partial};
use reverie_contracts::{
    resource_config::ResourceIdentitySettings,
    worker_config::EffectiveWorkerConfig,
    worker_nix::{NixConfiguration, NixPreparationArguments},
};
use reverie_core::{ids::ProfileSessionId, posix_path::PosixPath};
use reverie_store::storage_identity::{self, StorageIdentityConfig};
use std::{ffi::OsStr, fs::File, path::PathBuf};

fn identity(config: &NixConfiguration) -> Result<StorageIdentityConfig> {
    let settings = ResourceIdentitySettings::capture_worker_config(config.source())
        .map_err(crate::worker_storage::StorageError::from)?;
    Ok(StorageIdentityConfig::capture_worker_settings(&settings))
}
fn same_namespace(raw: &NixConfiguration, prepared: &NixConfiguration) -> Result<()> {
    let left = ResourceIdentitySettings::capture_worker_config(raw.source())
        .map_err(crate::worker_storage::StorageError::from)?;
    let right = ResourceIdentitySettings::capture_worker_config(prepared.source())
        .map_err(crate::worker_storage::StorageError::from)?;
    need(
        left.uid() == right.uid()
            && left.company_file() == right.company_file()
            && left.state_root() == right.state_root()
            && left.scratch_root() == right.scratch_root(),
        NixFault::StoreBinding,
    )
}
fn lexical(text: &reverie_contracts::storage_identity::MetadataText) -> Result<PosixPath> {
    PosixPath::try_new(text.codepoints())
        .map_err(|_| NixError::Io(std::io::ErrorKind::InvalidInput.into()))
}
fn session_path(config: &NixConfiguration, session: &ProfileSessionId) -> Result<PathBuf> {
    Ok(native::python_path(&lexical(&config.state_root()?)?.codepoints())?.join(session.as_str()))
}
fn session_directory(
    config: &NixConfiguration,
    session: &ProfileSessionId,
    effects: &mut bool,
) -> Result<Directory> {
    let root = lexical(&config.state_root()?)?;
    let scratch = native::resolve_optional_text(config.scratch_root()?.codepoints())?;
    need(
        native::resolve_optional_text(&root.codepoints())? == root
            && !root.is_relative_to(&scratch),
        NixFault::DurableRoot,
    )?;
    let mounts = reverie_contracts::worker_storage::StorageConfiguration::capture(config.source());
    for source in mounts
        .shared_sources()
        .map_err(storage_identity::IdentityError::from)?
    {
        let source = source.map_err(storage_identity::IdentityError::from)?;
        need(
            !root.is_relative_to(&native::resolve_optional_text(source.codepoints())?),
            NixFault::DurableRoot,
        )?;
    }
    let uid = config.uid()?;
    let base = Directory::nix_directory(
        &native::python_path(&root.codepoints())?,
        uid,
        true,
        effects,
    )?;
    let result = (|| {
        Ok(Directory::nix_directory(
            &session_path(config, session)?,
            uid,
            true,
            effects,
        )?)
    })();
    match (result, base.close().map_err(Into::into)) {
        (Ok(child), Ok(())) => Ok(child),
        (Ok(child), Err(error)) => finalized(Err(error), child.close().map_err(Into::into)),
        (Err(error), closed) => finalized(Err(error), closed),
    }
}
/// Session-scoped Nix creation/migration serialization. Retain through helper
/// settlement and actual container creation. The separate employee StorageLease
/// still owns cross-session home/store exclusion for the laptop lifetime.
pub struct NixStoreGuard {
    config: NixConfiguration,
    session: ProfileSessionId,
    directory: Option<Directory>,
    file: Option<File>,
}
impl NixStoreGuard {
    pub fn acquire_launch(
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<Self> {
        Self::acquire(source, session, false)
    }
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
        let config = NixConfiguration::capture(source);
        let mut effects = false;
        let result = Self::open(config, session.clone(), migration, &mut effects);
        partial(result, effects)
    }
    fn open(
        config: NixConfiguration,
        session: ProfileSessionId,
        migration: bool,
        effects: &mut bool,
    ) -> Result<Self> {
        let directory = session_directory(&config, &session, effects)?;
        let file = match directory.lock_file(OsStr::new("nix.lock"), effects) {
            Ok(file) => file,
            Err(error) => {
                return finalized(Err(error.into()), directory.close().map_err(Into::into));
            }
        };
        let result = (|| {
            directory.nix_lock_current(&file, OsStr::new("nix.lock"))?;
            match file.try_lock() {
                Ok(()) => {}
                Err(std::fs::TryLockError::WouldBlock) => {
                    return Err(NixError::Refused(NixFault::Busy));
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
            }
            if !migration {
                selection::check_fences(&config, &session)?;
            }
            directory.nix_lock_current(&file, OsStr::new("nix.lock"))?;
            Ok(())
        })();
        if let Err(error) = result {
            return finalized(
                finalized(Err(error), native::close(file).map_err(Into::into)),
                directory.close().map_err(Into::into),
            );
        }
        Ok(Self {
            config,
            session,
            directory: Some(directory),
            file: Some(file),
        })
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn directory(&self) -> Result<PathBuf> {
        session_path(&self.config, &self.session)
    }
    pub fn selected_path(&self) -> Result<PathBuf> {
        selection::store_path(&self.config, &self.session)
    }
    pub fn prepare_private_store(&mut self, prepared: &EffectiveWorkerConfig) -> Result<PathBuf> {
        self.assert_current()?;
        let prepared = NixConfiguration::capture(prepared);
        same_namespace(&self.config, &prepared)?;
        let mut effects = false;
        let result = selection::private_store(&prepared, &self.session, &mut effects);
        partial(finalized(result, self.assert_current()), effects)
    }
    pub fn preparation_arguments(
        &self,
        prepared: &EffectiveWorkerConfig,
        selected_path: &std::path::Path,
    ) -> Result<NixPreparationArguments> {
        self.assert_current()?;
        let prepared = NixConfiguration::capture(prepared);
        same_namespace(&self.config, &prepared)?;
        let selected = selection::store_path_text(&prepared, &self.session)?;
        need(
            native::python_path(&selected.codepoints())? == selected_path,
            NixFault::StoreBinding,
        )?;
        let text = reverie_contracts::storage_identity::MetadataText::from_python_text(
            reverie_core::PythonText::try_new(selected.codepoints()).expect("path codepoints"),
        );
        Ok(NixPreparationArguments::capture(
            &prepared,
            &self.session,
            &text,
        )?)
    }
    fn assert_current(&self) -> Result<()> {
        let directory = self
            .directory
            .as_ref()
            .ok_or(NixError::Refused(NixFault::Closed))?;
        let file = self
            .file
            .as_ref()
            .ok_or(NixError::Refused(NixFault::Closed))?;
        Ok(directory.nix_lock_current(file, OsStr::new("nix.lock"))?)
    }
    pub fn close(mut self) -> Result<()> {
        let result = self.assert_current();
        let file = self
            .file
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into));
        let directory = self
            .directory
            .take()
            .map_or(Ok(()), |d| d.close().map_err(Into::into));
        finalized(finalized(result, file), directory)
    }
}
/// Pure selection plus actual metadata observations, without initialization,
/// store locking, image selection or engine execution authority.
pub fn store_path(source: &EffectiveWorkerConfig, session: &ProfileSessionId) -> Result<PathBuf> {
    selection::store_path(&NixConfiguration::capture(source), session)
}
