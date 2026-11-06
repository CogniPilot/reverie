use super::*;
use crate::{
    memory_recall::{STARTUP_MODEL, STARTUP_READY, STARTUP_STATE},
    memory_startup::StartedMemory,
};
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::{
    memory::{Embedder, HashedEmbedder},
    memory_configuration::FloatSetting,
};
use reverie_host::memory_lifecycle::{MemoryOperationLock, scope_directory};
use reverie_store::memory::{MemoryError, MemoryReadProfile, MemoryStore};
use std::sync::Arc;
enum Database {
    Started(StartedMemory),
    Project(MemoryStore),
    Profile(MemoryReadProfile),
    Recall(MemoryRecall),
}
#[derive(Default)]
pub(super) struct Resources {
    database: Option<Database>,
    control: Option<MemoryOperationLock>,
}
pub(super) enum CloseFailure {
    Pending(MemoryLifecycleError),
    Consumed(MemoryLifecycleError),
}
impl CloseFailure {
    pub(super) fn into_error(self) -> MemoryLifecycleError {
        match self {
            Self::Pending(error) | Self::Consumed(error) => error,
        }
    }
}
impl Resources {
    pub(super) fn close(&mut self) -> std::result::Result<(), CloseFailure> {
        if let Some(database) = &mut self.database {
            let result = match database {
                Database::Started(held) => held.close(),
                Database::Project(held) => held.close(),
                Database::Profile(held) => held.close(),
                Database::Recall(held) => held.close(),
            };
            // SQLite returns its actual connection on failed close. Keep its
            // scope lock and namespace until that owned connection settles.
            result.map_err(|error| CloseFailure::Pending(error.into()))?;
            self.database = None;
        }
        if let Some(control) = &mut self.control {
            // This synchronous fixed-file owner attempts every held descriptor
            // once before returning an error. Its sticky refusal is not work
            // that another close invocation could finish.
            control
                .close()
                .map_err(|error| CloseFailure::Consumed(error.into()))?;
            self.control = None;
        }
        Ok(())
    }
    fn path(&self) -> std::path::PathBuf {
        self.control
            .as_ref()
            .expect("operation owns scope")
            .database_path()
    }
}
impl State {
    pub(super) fn startup(
        &mut self,
        scope: &MemoryScope,
        seeds: &[MemorySeed],
        resources: &mut Resources,
    ) -> Result<ScopeStartupReport> {
        self.configuration.ensure_directories()?;
        if matches!(scope, MemoryScope::Project(_)) {
            std::fs::create_dir_all(scope_directory(&self.configuration, scope)?)?;
        }
        resources.control = Some(MemoryOperationLock::startup(&self.configuration, scope)?);
        match scope {
            MemoryScope::Private => {
                let started = StartedMemory::initialize_selected(
                    &self.configuration,
                    seeds,
                    self.candidates.select_at_startup(),
                )?;
                let report = started.report().clone();
                resources.database = Some(Database::Started(started));
                Ok(ScopeStartupReport::Private(report))
            }
            MemoryScope::Project(_) => self.start_project(resources),
        }
    }
    fn start_project(&self, resources: &mut Resources) -> Result<ScopeStartupReport> {
        let store = MemoryStore::open(resources.path())?;
        resources.database = Some(Database::Project(store));
        let Some(Database::Project(store)) = &resources.database else {
            unreachable!("stored actual project connection")
        };
        let name = store
            .embedder_name()?
            .scalar_text()
            .ok_or(MemoryError::NeedsMigration)?;
        store.atomic_immediate(|tx| {
            tx.set_state(STARTUP_MODEL, &name)?;
            tx.set_state(STARTUP_STATE, STARTUP_READY)?;
            Ok(())
        })?;
        Ok(ScopeStartupReport::Project)
    }
    pub(super) fn recall(
        &mut self,
        scope: &MemoryScope,
        query: EmbeddingText<'_>,
        resources: &mut Resources,
    ) -> Result<Vec<MemoryView>> {
        resources.control = Some(MemoryOperationLock::recall(&self.configuration, scope)?);
        resources.database = Some(Database::Profile(MemoryReadProfile::open(
            resources.path(),
        )?));
        let Some(Database::Profile(profile)) = &resources.database else {
            unreachable!("stored actual profile reader")
        };
        match profile.get_state(STARTUP_STATE)?.as_deref() {
            Some(STARTUP_READY) => (),
            Some("profile-pending") => return Err(MemoryError::NeedsProfileRefresh.into()),
            _ => return Err(MemoryError::NotInitialized.into()),
        }
        let name = MetadataText::from_scalar_text(
            &profile
                .get_state(STARTUP_MODEL)?
                .ok_or(MemoryError::NeedsMigration)?,
        );
        let (embedder, decay, count) = match scope {
            MemoryScope::Private => (
                self.candidates
                    .for_profile(&name)
                    .ok_or(MemoryError::NeedsMigration)?,
                self.configuration
                    .settings()
                    .float(FloatSetting::RecencyDecay),
                8,
            ),
            MemoryScope::Project(_) => {
                let backend = HashedEmbedder::default();
                if Embedder::name(&backend).codepoints().as_ref() != name.codepoints() {
                    return Err(MemoryError::NeedsMigration.into());
                }
                (Arc::new(backend) as Arc<dyn Embedder>, 0.995, 6)
            }
        };
        let Some(Database::Profile(profile)) = resources.database.take() else {
            unreachable!("profile transition owns one connection")
        };
        let reader = MemoryRecall::bind_existing(profile.bind(embedder, decay)?, count);
        resources.database = Some(Database::Recall(reader));
        let Some(Database::Recall(reader)) = &resources.database else {
            unreachable!("stored actual recall reader")
        };
        Ok(reader.recall_text(query)?)
    }
}
