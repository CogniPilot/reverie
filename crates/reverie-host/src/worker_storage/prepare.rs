use super::{
    Configuration, StorageFault,
    error::{Result, finalized, need},
    fs::{self, Directory},
};
use reverie_contracts::worker_storage::{ready_storage_bytes, storage_binding_bytes};
use reverie_store::storage_identity::{self, StoragePaths};
use std::{collections::BTreeSet, ffi::OsStr, path::Path};

pub(super) fn prepare(
    config: &Configuration,
    paths: &StoragePaths,
    effects: &mut bool,
) -> Result<()> {
    config.same_binding(paths)?;
    let base = config.base(true, effects)?;
    let result = prepare_bound(config, paths, effects);
    finalized(result, base.close())
}
fn prepare_bound(config: &Configuration, paths: &StoragePaths, effects: &mut bool) -> Result<()> {
    if let Some(employee) = paths.employee() {
        let employees =
            Directory::ensure(&config.state()?.join("employees"), config.uid(), effects)?;
        employees.close()?;
        legacy_check(config, paths)?;
        let marker = paths.root().join("storage.json");
        if fs::present(&marker)? {
            need(
                storage_identity::read_metadata(&marker, config.uid(), 65536)?
                    .matches_ready_storage(employee),
                StorageFault::ReadyMarker,
            )?;
            return validate_directories(config, paths);
        }
    }
    let root = Directory::ensure(paths.root(), config.uid(), effects)?;
    let result = (|| {
        Directory::ensure(paths.home(), config.uid(), effects)?.close()?;
        if let Some(employee) = paths.employee() {
            Directory::ensure(paths.nix(), config.uid(), effects)?.close()?;
            root.publish(
                OsStr::new("storage.json"),
                &ready_storage_bytes(employee),
                effects,
            )?;
        }
        Ok(())
    })();
    finalized(result, root.close())
}
fn legacy_check(config: &Configuration, paths: &StoragePaths) -> Result<()> {
    let mut sessions = BTreeSet::from([paths.session().clone()]);
    let journal = config.journal()?;
    if fs::present(&journal)? {
        sessions.extend(
            storage_identity::read_metadata(&journal, config.uid(), 1024 * 1024)?
                .storage_migration_sessions(
                    paths.employee().expect("employee branch"),
                    paths.owner(),
                )?,
        );
    }
    let base = config.state()?;
    let scratch = config.scratch()?;
    let marker = paths.root().join("storage.json");
    for session in sessions {
        for candidate in [
            base.join(session.as_str()).join("home"),
            base.join(session.as_str()).join("nix"),
            scratch.join(session.as_str()).join("nix"),
        ] {
            if fs::present(&candidate)? {
                // Path.exists follows a dangling marker symlink and reports
                // false. The later metadata read still refuses every symlink.
                need(marker.try_exists()?, StorageFault::PairedMigration)?;
                return Ok(());
            }
        }
    }
    Ok(())
}
fn private(path: &Path, config: &Configuration) -> Result<()> {
    Directory::open(path, config.uid())?.close()
}
fn validate_directories(config: &Configuration, paths: &StoragePaths) -> Result<()> {
    private(paths.root(), config)?;
    private(paths.home(), config)?;
    if paths.employee().is_some() {
        private(paths.nix(), config)?;
    }
    Ok(())
}
pub(super) fn validate(config: &Configuration, paths: &StoragePaths) -> Result<()> {
    config.base(false, &mut false)?.close()?;
    validate_directories(config, paths)?;
    if let Some(employee) = paths.employee() {
        need(
            storage_identity::read_metadata(
                &paths.root().join("storage.json"),
                config.uid(),
                65536,
            )?
            .matches_ready_storage(employee),
            StorageFault::ReadyMarker,
        )?;
    }
    Ok(())
}
pub(super) fn record(
    config: &Configuration,
    paths: &StoragePaths,
    effects: &mut bool,
) -> Result<()> {
    let Some(employee) = paths.employee() else {
        return Ok(());
    };
    let company = storage_identity::read_company_metadata(&config.identity)?;
    need(
        company.has_current_storage_binding(employee, paths.session(), paths.owner())?,
        StorageFault::CurrentBinding,
    )?;
    let directory = Directory::ensure(
        &config.state()?.join(paths.session().as_str()),
        config.uid(),
        effects,
    )?;
    let result = (|| {
        let path = config
            .state()?
            .join(paths.session().as_str())
            .join("storage-owner.json");
        if fs::present(&path)? {
            need(
                storage_identity::read_metadata(&path, config.uid(), 65536)?
                    .matches_storage_binding(employee, paths.session(), paths.owner()),
                StorageFault::StoredLineage,
            )
        } else {
            directory.publish(
                OsStr::new("storage-owner.json"),
                &storage_binding_bytes(employee, paths.session(), paths.owner()),
                effects,
            )
        }
    })();
    finalized(result, directory.close())
}
