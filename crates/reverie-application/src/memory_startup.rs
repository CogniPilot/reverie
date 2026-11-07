//! Explicit startup/migration workflow. Installation supplies the namespace and
//! independently selected settings; its authenticated lifecycle owner must
//! serialize this operation against active recall/other startup contexts.
//! Configuration, readiness text and employee titles are never that authority.
use crate::memory_import::migrate_history_atomic;
use reverie_contracts::{memory_documents::SelfModelDraft, storage_identity::MetadataText};
use reverie_core::shutdown::ShutdownStatus;
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
use reverie_store::memory::{MemoryError, MemoryStartupStore, MemoryStore, MemoryTransaction};
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
#[derive(Clone)]
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
    Retained {
        primary: Box<Self>,
        secondary: MemoryError,
        owner: Box<MemoryStartupStore>,
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
        let mut owner = MemoryStartupStore::open(configuration.native_path(MemoryPath::Database)?)?;
        let prepared = (|| {
            owner.preflight()?;
            let selection = configuration.select_embeddings();
            owner.admit(
                selection.embedder,
                configuration.settings().float(FloatSetting::RecencyDecay),
            )?;
            initialize_admitted(&mut owner, configuration, seeds, selection.fallback)
        })();
        let report = match prepared {
            Ok(report) => report,
            Err(primary) => {
                return match owner.shutdown() {
                    ShutdownStatus::Complete => Err(primary),
                    ShutdownStatus::Pending(secondary) | ShutdownStatus::Refused(secondary) => {
                        Err(StartupError::Retained {
                            primary: Box::new(primary),
                            secondary,
                            owner: Box::new(owner),
                        })
                    }
                };
            }
        };
        match owner.into_ready() {
            Ok(store) => Ok(Self::from_ready(store, report, configuration)),
            Err(owner) => Err(StartupError::Retained {
                primary: Box::new(MemoryError::ReadinessUnconfirmed.into()),
                secondary: MemoryError::ReadinessUnconfirmed,
                owner,
            }),
        }
    }
    pub(crate) fn from_ready(
        store: MemoryStore,
        report: StartupReport,
        configuration: &MemoryConfiguration,
    ) -> Self {
        Self {
            store,
            report,
            decay: configuration.settings().float(FloatSetting::RecencyDecay),
            count: slice_count(
                configuration
                    .settings()
                    .integer(IntegerSetting::RecallCount),
            ),
            closed: Arc::new(AtomicBool::new(false)),
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
        self.shutdown().into_result()
    }
    pub fn shutdown(&self) -> ShutdownStatus<MemoryError> {
        self.closed.store(true, Ordering::Release);
        self.store.shutdown()
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
pub(crate) fn initialize_admitted(
    owner: &mut MemoryStartupStore,
    configuration: &MemoryConfiguration,
    seeds: &[MemorySeed],
    fallback: Option<EmbeddingFallback>,
) -> Result<StartupReport, StartupError> {
    // Invalidate readiness before the first explicit migration effect. Recall
    // refuses pending initialization instead of labelling missing boot empty.
    let store = owner.store()?;
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
    owner.profile_pending()?;
    let profile = refresh_missing_profile(owner.store()?, configuration)?;
    owner.ready()?;
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
