//! Employee recall over a service-installed namespace/model. Paths, models and
//! scope come from installation, never a request-selected employee/path label.
//! This service cannot bootstrap or write the selected memory database.
use reverie_contracts::memory::MemoryView;
use reverie_core::memory::{Embedder, EmbeddingText};
use reverie_store::memory::{MemoryError, MemoryReader, RetrievalOptions};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub(crate) const STARTUP_STATE: &str = "native_memory_startup_v1";
pub(crate) const STARTUP_READY: &str = "ready";
pub(crate) const STARTUP_MODEL: &str = "native_memory_embed_model_v1";
pub struct MemoryRecall {
    reader: MemoryReader,
    count: i64,
    lifecycle: Option<Arc<AtomicBool>>,
}
impl MemoryRecall {
    /// Bind the actual caller's filesystem/network namespace. A host service
    /// must not reinterpret a guest path or its loopback embedding endpoint.
    /// The caller separately enforces authentication and current memory scope.
    pub fn open_existing(
        path: impl AsRef<Path>,
        embedder: Arc<dyn Embedder>,
        decay_per_hour: f64,
        count: i64,
    ) -> Result<Self, MemoryError> {
        let reader = MemoryReader::open_with(path, embedder, decay_per_hour)?;
        let readiness = require_ready(&reader);
        if let Err(primary) = readiness {
            return match reader.close() {
                Ok(()) => Err(primary),
                Err(secondary) => Err(MemoryError::Finalization {
                    primary: Box::new(primary),
                    secondary: Box::new(secondary),
                }),
            };
        }
        Ok(Self {
            reader,
            count,
            lifecycle: None,
        })
    }
    pub fn recall(&self, query: &str) -> Result<Vec<MemoryView>, MemoryError> {
        self.recall_text(EmbeddingText::from_scalar_text(query))
    }
    pub fn recall_text(&self, query: EmbeddingText<'_>) -> Result<Vec<MemoryView>, MemoryError> {
        self.require_active()?;
        require_ready(&self.reader)?;
        let memories = self
            .reader
            .retrieve_text(
                query,
                RetrievalOptions {
                    k: self.count,
                    ..Default::default()
                },
            )?
            .into_iter()
            .map(|memory| memory.as_dict())
            .collect();
        require_ready(&self.reader)?;
        self.require_active()?;
        Ok(memories)
    }
    pub fn close(&self) -> Result<(), MemoryError> {
        self.reader.close()
    }
    pub(crate) fn under_lifecycle(mut self, closed: Arc<AtomicBool>) -> Self {
        self.lifecycle = Some(closed);
        self
    }
    fn require_active(&self) -> Result<(), MemoryError> {
        if self
            .lifecycle
            .as_ref()
            .is_some_and(|closed| closed.load(Ordering::Acquire))
        {
            Err(MemoryError::Closed)
        } else {
            Ok(())
        }
    }
}
fn require_ready(reader: &MemoryReader) -> Result<(), MemoryError> {
    match reader.get_state(STARTUP_STATE)?.as_deref() {
        Some(STARTUP_READY) => {
            let selected = reader
                .embedder_name()
                .scalar_text()
                .ok_or(reverie_core::memory::EmbeddingError::InvalidText)?;
            if reader.get_state(STARTUP_MODEL)?.as_deref() == Some(selected.as_str()) {
                Ok(())
            } else {
                Err(MemoryError::NeedsMigration)
            }
        }
        Some("profile-pending") => Err(MemoryError::NeedsProfileRefresh),
        _ => Err(MemoryError::NotInitialized),
    }
}
