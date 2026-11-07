use super::*;
use crate::memory_startup::{StartedMemory, initialize_admitted};
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::{
    memory::{Embedder, HashedEmbedder, MemoryStartupPhase},
    memory_configuration::FloatSetting,
};
use reverie_host::memory_lifecycle::{MemoryOperationLock, scope_directory};
use reverie_store::memory::{
    MemoryError, MemoryReadProfile, MemoryStartupStore, MemoryStore, NativeMemoryRead,
};
use std::sync::Arc;
enum Database {
    Starting(MemoryStartupStore),
    Started(StartedMemory),
    Project(MemoryStore),
    Captured(NativeMemoryRead),
    Profile(MemoryReadProfile),
    Recall(MemoryRecall),
}
#[derive(Default)]
pub(super) struct Resources {
    database: Option<Database>,
    control: Option<MemoryOperationLock>,
    refused: bool,
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
        let result = if self.refused {
            Err(MemoryLifecycleError::Unconfirmed)
        } else {
            Ok(())
        };
        if let Some(database) = &mut self.database {
            let status = match database {
                Database::Starting(held) => held.shutdown(),
                Database::Started(held) => held.shutdown(),
                Database::Project(held) => held.shutdown(),
                Database::Captured(held) => held.shutdown(),
                Database::Profile(held) => held.shutdown(),
                Database::Recall(held) => held.shutdown(),
            };
            // SQLite returns its actual connection on failed close. Keep its
            // scope lock and namespace until that owned connection settles.
            match status {
                ShutdownStatus::Complete => self.database = None,
                ShutdownStatus::Pending(error) => return Err(CloseFailure::Pending(error.into())),
                ShutdownStatus::Refused(error) => {
                    self.database = None;
                    self.refused = true;
                    // Continue the remaining fixed control finalizers after a
                    // consumed negative; it is not an unsettled connection.
                    return self.close_control(error::finalized(result, Err(error.into())));
                }
            }
        }
        self.close_control(result)
    }
    fn close_control(&mut self, mut result: Result<()>) -> std::result::Result<(), CloseFailure> {
        if let Some(control) = &mut self.control {
            // This synchronous fixed-file owner attempts every held descriptor
            // once before returning an error. Its sticky refusal is not work
            // that another close invocation could finish.
            let closed = control.close();
            if closed.is_err() {
                self.refused = true;
            }
            result = error::finalized(result, closed.map_err(Into::into));
            self.control = None;
        }
        result.map_err(CloseFailure::Consumed)
    }
    fn path(&self) -> std::path::PathBuf {
        self.control
            .as_ref()
            .expect("operation owns scope")
            .database_path()
    }
    fn open_startup(&mut self) -> Result<()> {
        self.database = Some(Database::Starting(MemoryStartupStore::open(self.path())?));
        self.starting()?.preflight()?;
        Ok(())
    }
    fn open_profile(&mut self) -> Result<()> {
        self.database = Some(Database::Captured(NativeMemoryRead::capture(self.path())?));
        let Some(Database::Captured(owner)) = &self.database else {
            unreachable!("stored actual native read owner")
        };
        owner.qualify()?;
        let Some(Database::Captured(owner)) = self.database.take() else {
            unreachable!("qualified owner is retained until its move")
        };
        match owner.into_profile() {
            Ok(profile) => {
                self.database = Some(Database::Profile(profile));
                Ok(())
            }
            Err(owner) => {
                self.database = Some(Database::Captured(*owner));
                Err(MemoryError::ReadinessUnconfirmed.into())
            }
        }
    }
    fn starting(&mut self) -> Result<&mut MemoryStartupStore> {
        match &mut self.database {
            Some(Database::Starting(owner)) => Ok(owner),
            _ => Err(MemoryError::ReadinessUnconfirmed.into()),
        }
    }
    fn take_ready(&mut self) -> Result<MemoryStore> {
        let Some(Database::Starting(owner)) = self.database.take() else {
            return Err(MemoryError::ReadinessUnconfirmed.into());
        };
        match owner.into_ready() {
            Ok(store) => Ok(store),
            Err(owner) => {
                self.database = Some(Database::Starting(*owner));
                Err(MemoryError::ReadinessUnconfirmed.into())
            }
        }
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
        resources.open_startup()?;
        match scope {
            MemoryScope::Private => {
                let selection = self.candidates.select_at_startup();
                resources.starting()?.admit(
                    selection.embedder,
                    self.configuration
                        .settings()
                        .float(FloatSetting::RecencyDecay),
                )?;
                let report = initialize_admitted(
                    resources.starting()?,
                    &self.configuration,
                    seeds,
                    selection.fallback,
                )?;
                let started = StartedMemory::from_ready(
                    resources.take_ready()?,
                    report.clone(),
                    &self.configuration,
                );
                resources.database = Some(Database::Started(started));
                Ok(ScopeStartupReport::Private(report))
            }
            MemoryScope::Project(_) => self.start_project(resources),
        }
    }
    fn start_project(&self, resources: &mut Resources) -> Result<ScopeStartupReport> {
        resources
            .starting()?
            .admit(Arc::new(HashedEmbedder::default()), 0.995)?;
        resources.starting()?.ready()?;
        resources.database = Some(Database::Project(resources.take_ready()?));
        Ok(ScopeStartupReport::Project)
    }
    pub(super) fn recall(
        &mut self,
        scope: &MemoryScope,
        query: EmbeddingText<'_>,
        resources: &mut Resources,
    ) -> Result<Vec<MemoryView>> {
        resources.control = Some(MemoryOperationLock::recall(&self.configuration, scope)?);
        resources.open_profile()?;
        let Some(Database::Profile(profile)) = &resources.database else {
            unreachable!("stored actual profile reader")
        };
        let readiness = profile
            .native_readiness()?
            .ok_or(MemoryError::NotInitialized)?;
        match readiness.phase() {
            MemoryStartupPhase::Ready => (),
            MemoryStartupPhase::ProfilePending => {
                return Err(MemoryError::NeedsProfileRefresh.into());
            }
            MemoryStartupPhase::Initializing => return Err(MemoryError::NotInitialized.into()),
        }
        let name = MetadataText::from_scalar_text(
            readiness
                .model()
                .ok_or(MemoryError::MalformedReadinessMetadata)?,
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
