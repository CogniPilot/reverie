//! Explicit startup/migration workflow. Installation supplies the namespace and
//! independently selected settings; its authenticated lifecycle owner must
//! serialize this operation against active recall/other startup contexts.
//! Configuration, readiness text and employee titles are never that authority.
use crate::{
    memory_import::migrate_history_atomic,
    memory_recall::{STARTUP_MODEL, STARTUP_READY, STARTUP_STATE},
};
use reverie_contracts::{memory_documents::SelfModelDraft, storage_identity::MetadataText};
use reverie_core::{
    PythonText,
    memory::collapse_whitespace,
    memory_configuration::{FloatSetting, IntegerSetting, TextSetting},
    persona::{ProfileEntry, SectionAliases, render_profile},
};
use reverie_host::{
    embeddings::EmbeddingFallback,
    memory_configuration::{MemoryConfiguration, MemoryPath},
    memory_profile::{ProfileError, ProfileFile, ProfileOutcome},
};
use reverie_store::memory::{MemoryError, MemoryStore, MemoryTransaction};
use std::{
    collections::BTreeSet,
    fmt, io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub struct MemorySeed {
    pub text: MetadataText,
    pub weight: f64,
}
pub struct StartupReport {
    pub reembedded: usize,
    pub imported: usize,
    pub seeded: usize,
    pub initial_identity_created: bool,
    pub profile: ProfileOutcome,
    pub embedding_fallback: Option<EmbeddingFallback>,
}
#[derive(Debug)]
pub enum StartupError {
    Store(MemoryError),
    Io(io::Error),
    Profile(ProfileError),
    Render(reverie_core::persona::ProfileRenderError),
    Finalization {
        primary: Box<Self>,
        secondary: MemoryError,
    },
}
impl fmt::Display for StartupError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "{self:?}")
    }
}
impl std::error::Error for StartupError {}
impl From<MemoryError> for StartupError {
    fn from(error: MemoryError) -> Self {
        Self::Store(error)
    }
}
impl From<io::Error> for StartupError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<ProfileError> for StartupError {
    fn from(error: ProfileError) -> Self {
        Self::Profile(error)
    }
}
#[must_use = "retain the installed memory context and explicitly close it"]
pub struct StartedMemory {
    store: MemoryStore,
    report: StartupReport,
    decay: f64,
    count: i64,
    closed: Arc<AtomicBool>,
}
impl StartedMemory {
    /// Explicit side effects only. Later HTTP embedding failures propagate;
    /// the startup-selected backend is never reselected during recall.
    pub fn initialize(
        configuration: &MemoryConfiguration,
        seeds: &[MemorySeed],
    ) -> Result<Self, StartupError> {
        configuration.ensure_directories()?;
        let selection = configuration.select_embeddings();
        let store = MemoryStore::open_with(
            configuration.native_path(MemoryPath::Database)?,
            selection.embedder,
            configuration.settings().float(FloatSetting::RecencyDecay),
        )?;
        match initialize(&store, configuration, seeds, selection.fallback) {
            Ok(report) => {
                let count = configuration
                    .settings()
                    .integer(IntegerSetting::RecallCount);
                let count = slice_count(count);
                Ok(Self {
                    store,
                    report,
                    decay: configuration.settings().float(FloatSetting::RecencyDecay),
                    count,
                    closed: Arc::new(AtomicBool::new(false)),
                })
            }
            Err(primary) => match store.close() {
                Ok(()) => Err(primary),
                Err(secondary) => Err(StartupError::Finalization {
                    primary: Box::new(primary),
                    secondary,
                }),
            },
        }
    }
    pub fn store(&self) -> &MemoryStore {
        &self.store
    }
    pub fn report(&self) -> &StartupReport {
        &self.report
    }
    /// Close the writer and fence attached recalls. Each existing reader still
    /// owns its descriptor and must close before namespace shutdown is acked.
    pub fn close(&self) -> Result<(), MemoryError> {
        self.closed.store(true, Ordering::Release);
        self.store.close()
    }
    pub fn recall_service(&self) -> Result<crate::memory_recall::MemoryRecall, MemoryError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(MemoryError::Closed);
        }
        let reader = crate::memory_recall::MemoryRecall::open_existing(
            self.store.path(),
            self.store.selected_embedder()?,
            self.decay,
            self.count,
        )?;
        if self.closed.load(Ordering::Acquire) {
            return match reader.close() {
                Ok(()) => Err(MemoryError::Closed),
                Err(secondary) => Err(MemoryError::Finalization {
                    primary: Box::new(MemoryError::Closed),
                    secondary: Box::new(secondary),
                }),
            };
        }
        Ok(reader.under_lifecycle(Arc::clone(&self.closed)))
    }
}
fn slice_count(value: &reverie_core::memory_configuration::ConfigInteger) -> i64 {
    value.to_i64().unwrap_or_else(|| {
        if value.as_str().starts_with('-') {
            i64::MIN
        } else {
            i64::MAX
        }
    })
}
fn initialize(
    store: &MemoryStore,
    configuration: &MemoryConfiguration,
    seeds: &[MemorySeed],
    fallback: Option<EmbeddingFallback>,
) -> Result<StartupReport, StartupError> {
    // Invalidate readiness before the first explicit migration effect. Recall
    // refuses pending initialization instead of labelling missing boot empty.
    store.set_state(STARTUP_STATE, "initializing")?;
    let reembedded = store.reembed_all()?;
    let initial = configuration
        .instance()
        .map(|instance| instance.configuration().initial_model())
        .transpose()
        .map_err(MemoryError::from)?;
    let documents = store.documents(initial.clone());
    documents.initialize()?;
    let (seeded, initial_identity_created) = store.atomic_immediate(|tx| {
        let fresh = tx.beliefs()?.is_empty();
        let seeded = ensure_seeds(tx, seeds)?;
        let mut created = false;
        if fresh && let Some(initial) = initial {
            let model = SelfModelDraft::from_body(initial)?;
            created = documents.in_transaction(tx)?.initialize_identity(
                &model,
                &MetadataText::from_scalar_text("Owner-selected initial instance identity"),
            )?;
        }
        Ok((seeded, created))
    })?;
    let imported = migrate_history_atomic(
        store,
        configuration.native_path(MemoryPath::LegacyHistory)?,
        configuration
            .settings()
            .float(FloatSetting::DefaultImportance),
    )?;
    store.set_state(STARTUP_STATE, "profile-pending")?;
    let profile = refresh_missing_profile(store, configuration)?;
    let selected = store
        .embedder_name()?
        .scalar_text()
        .ok_or(reverie_core::memory::EmbeddingError::InvalidText)
        .map_err(MemoryError::from)?;
    store.set_state(STARTUP_MODEL, &selected)?;
    store.set_state(STARTUP_STATE, STARTUP_READY)?;
    Ok(StartupReport {
        reembedded,
        imported,
        seeded,
        initial_identity_created,
        profile,
        embedding_fallback: fallback,
    })
}
fn ensure_seeds(
    tx: &mut MemoryTransaction<'_>,
    seeds: &[MemorySeed],
) -> Result<usize, MemoryError> {
    if tx.get_state("revisable_self_model", None)?.as_deref() == Some("1") {
        return Ok(0);
    }
    let mut have = tx
        .beliefs()?
        .into_iter()
        .map(|belief| belief.text)
        .collect::<BTreeSet<_>>();
    let mut count = 0;
    for seed in seeds {
        let text = seed
            .text
            .scalar_text()
            .ok_or(reverie_core::memory::EmbeddingError::InvalidText)?;
        let normalized = collapse_whitespace(&text);
        if have.insert(normalized.clone()) {
            tx.add_belief(&normalized, seed.weight, None, true, None)?;
            count += 1;
        }
    }
    Ok(count)
}
fn refresh_missing_profile(
    store: &MemoryStore,
    configuration: &MemoryConfiguration,
) -> Result<ProfileOutcome, StartupError> {
    let profile = ProfileFile::for_configuration(configuration)?;
    if profile.is_present()? {
        return Ok(ProfileOutcome::Existing);
    }
    let entries = store
        .reflections()?
        .into_iter()
        .map(|memory| ProfileEntry {
            id: memory.id,
            importance: memory.importance,
            created_at: memory.created_at,
            text: PythonText::from_scalar_text(&memory.text),
            section: PythonText::from_scalar_text(&memory.section),
        })
        .collect::<Vec<_>>();
    let settings = configuration.settings();
    let aliases = SectionAliases::from_text(
        settings.text(TextSetting::OwnerAliases).as_text_ref(),
        settings.text(TextSetting::AgentAliases).as_text_ref(),
    );
    let maximum = settings
        .integer(IntegerSetting::ProfileMaxCharacters)
        .to_i64()
        .expect("fixed profile bound");
    let text = render_profile(&entries, maximum, &aliases).map_err(StartupError::Render)?;
    Ok(profile.ensure(&text)?)
}
