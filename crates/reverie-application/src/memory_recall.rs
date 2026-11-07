//! Employee recall over a service-installed namespace/model. Paths, models and
//! scope come from installation, never a request-selected employee/path label.
//! This service cannot bootstrap or write the selected memory database.
use reverie_contracts::memory::MemoryView;
use reverie_core::memory::{Embedder, EmbeddingText, MemoryStartupPhase};
use reverie_store::memory::{MemoryError, MemoryReadProfile, MemoryReader, RetrievalOptions};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

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
        let reader = MemoryReadProfile::open_native(path)?.bind(embedder, decay_per_hour)?;
        Self::from_reader(reader, count)
    }
    pub(crate) fn from_reader(reader: MemoryReader, count: i64) -> Result<Self, MemoryError> {
        let readiness = require_ready(&reader);
        if let Err(primary) = readiness {
            return Err(reader.finalize_error(primary));
        }
        Ok(Self::bind_existing(reader, count))
    }
    pub(crate) fn bind_existing(reader: MemoryReader, count: i64) -> Self {
        Self {
            reader,
            count,
            lifecycle: None,
        }
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
    pub(crate) fn shutdown(&self) -> reverie_core::shutdown::ShutdownStatus<MemoryError> {
        self.reader.shutdown()
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
    let Some(readiness) = reader.native_readiness()? else {
        return Err(MemoryError::NotInitialized);
    };
    match readiness.phase() {
        MemoryStartupPhase::Ready => {
            let selected = reader
                .embedder_name()
                .scalar_text()
                .ok_or(reverie_core::memory::EmbeddingError::InvalidText)?;
            if readiness.model() == Some(selected.as_str()) {
                Ok(())
            } else {
                Err(MemoryError::NeedsMigration)
            }
        }
        MemoryStartupPhase::ProfilePending => Err(MemoryError::NeedsProfileRefresh),
        MemoryStartupPhase::Initializing => Err(MemoryError::NotInitialized),
    }
}
