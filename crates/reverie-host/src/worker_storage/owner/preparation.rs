//! Fixed launch filesystem prerequisites through the actual resource sum. The
//! legacy branch reuses each purpose owner without manufacturing a lease.
use super::*;
use crate::worker_storage::{error::partial, temporary};

impl LaunchStorage {
    /// The original pre-argument runtime-directory and selected-home phase.
    /// Actual resource/namespace ownership selects all paths internally.
    pub fn prepare_runtime_directory(&mut self) -> OwnerResult<()> {
        if let Ownership::Held(lease) = &mut self.ownership {
            return lease
                .prepare_runtime_directory()
                .map_err(StorageOwnerError::Storage);
        }
        let config = self.legacy_configuration()?;
        let mut effects = false;
        let result =
            crate::worker_storage::prepare::runtime_directory(&config, &self.paths, &mut effects);
        partial(result, effects).map_err(StorageOwnerError::Storage)
    }
    pub fn write_scratch_label(&mut self) -> OwnerResult<crate::worker_storage::LabelDisposition> {
        if let Ownership::Held(lease) = &mut self.ownership {
            return lease
                .write_scratch_label()
                .map_err(StorageOwnerError::Storage);
        }
        let config = self.legacy_configuration()?;
        let mut effects = false;
        let result = crate::worker_storage::label::write(&config, &self.paths, &mut effects);
        partial(result, effects).map_err(StorageOwnerError::Storage)
    }
    fn legacy_configuration(&self) -> OwnerResult<Configuration> {
        match &self.ownership {
            Ownership::UnleasedLegacy => {
                Configuration::capture(&self.source).map_err(StorageOwnerError::Storage)
            }
            Ownership::Held(_) => Err(StorageOwnerError::Refused(
                "WORKER_EMPLOYEE_STORAGE_LEASE_REQUIRED",
            )),
            Ownership::ConsumedUnconfirmed => Err(StorageOwnerError::Refused(
                "WORKER_STORAGE_CLOSE_UNCONFIRMED",
            )),
        }
    }
    pub fn prepare_storage(&mut self) -> OwnerResult<()> {
        if let Ownership::Held(lease) = &mut self.ownership {
            return lease.prepare_storage().map_err(StorageOwnerError::Storage);
        }
        let config = self.legacy_configuration()?;
        let mut effects = false;
        let result = crate::worker_storage::prepare::prepare(&config, &self.paths, &mut effects);
        partial(result, effects).map_err(StorageOwnerError::Storage)
    }
    pub fn record_storage_binding(&mut self) -> OwnerResult<()> {
        match &mut self.ownership {
            Ownership::Held(lease) => lease
                .record_storage_binding()
                .map_err(StorageOwnerError::Storage),
            // Keep the original legacy no-op BEFORE all metadata/settings I/O.
            Ownership::UnleasedLegacy => Ok(()),
            Ownership::ConsumedUnconfirmed => Err(StorageOwnerError::Refused(
                "WORKER_STORAGE_CLOSE_UNCONFIRMED",
            )),
        }
    }
    pub fn prepare_temporary(&mut self) -> OwnerResult<PathBuf> {
        if let Ownership::Held(lease) = &mut self.ownership {
            return lease
                .prepare_temporary()
                .map_err(StorageOwnerError::Storage);
        }
        let config = self.legacy_configuration()?;
        let mut effects = false;
        let result = temporary::temporary(&config, &self.paths, &mut effects);
        partial(result, effects).map_err(StorageOwnerError::Storage)
    }
    pub fn home_workspace_alias(&mut self) -> OwnerResult<()> {
        if let Ownership::Held(lease) = &mut self.ownership {
            return lease
                .home_workspace_alias()
                .map_err(StorageOwnerError::Storage);
        }
        let config = self.legacy_configuration()?;
        if !config
            .data
            .has_shared_workspace()
            .map_err(|error| StorageOwnerError::Storage(error.into()))?
        {
            return Ok(());
        }
        partial(temporary::workspace_alias(&self.paths), true).map_err(StorageOwnerError::Storage)
    }
    pub fn write_storage_instructions(&mut self) -> OwnerResult<()> {
        if let Ownership::Held(lease) = &mut self.ownership {
            return lease
                .write_storage_instructions()
                .map_err(StorageOwnerError::Storage);
        }
        let config = self.legacy_configuration()?;
        let mut effects = false;
        let original =
            temporary::path_text(&config, &self.paths).map_err(StorageOwnerError::Storage)?;
        let result = temporary::instructions(self.paths.home(), original.home(), &mut effects);
        partial(result, effects).map_err(StorageOwnerError::Storage)
    }
    /// Read-only restart snapshot, not an eligibility or stopped-writer proof.
    pub fn validate_storage(&self) -> OwnerResult<()> {
        self.check_resource_current()?;
        let result = crate::worker_storage::validate_storage(&self.source, &self.paths)
            .map_err(StorageOwnerError::Storage);
        let checked = self.check_resource_current().map(|_| ());
        match (result, checked) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Err(secondary)) => Err(StorageOwnerError::Finalized {
                primary: Box::new(primary),
                secondary: vec![secondary],
            }),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        }
    }
}
