//! Existing-memory observations. Opening never creates/migrates tables, selects
//! another model, imports history, seeds beliefs, or touches access timestamps.
use super::*;
use reverie_core::shutdown::ShutdownStatus;
use rusqlite::OptionalExtension;
mod native;
pub use native::NativeMemoryRead;

pub struct MemoryReader {
    connection: Mutex<Option<Connection>>,
    source: Mutex<Option<startup::source::Source>>,
    embedder: Arc<dyn Embedder>,
    decay_per_hour: f64,
}
/// Existing database/profile data before binding its startup-selected backend.
/// This owns the same read-only connection subsequently moved into the reader;
/// opening does not probe a model or create/migrate any database/schema.
pub struct MemoryReadProfile {
    connection: Option<Connection>,
    source: Option<startup::source::Source>,
}
impl MemoryReadProfile {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            connection: Some(open_existing(path.as_ref())?),
            source: None,
        })
    }
    /// Bind the actual native recall source and disable close-time checkpoints.
    /// Normal SQLite read marks/IPC remain allowed; this connection observes
    /// current transactions, unlike the finite startup-only main observation.
    /// Ordinary legacy readers keep their existing SQLite policy.
    pub fn open_native(path: impl AsRef<Path>) -> Result<Self> {
        let captured = NativeMemoryRead::capture(path)?;
        if let Err(primary) = captured.qualify() {
            return Err(captured.failed(primary));
        }
        captured
            .into_profile()
            .map_err(|owner| owner.failed(MemoryError::ReadinessUnconfirmed))
    }
    pub fn get_state(&self, key: &str) -> Result<Option<String>> {
        observed(
            self.connection.as_ref().ok_or(MemoryError::Closed)?,
            self.source.as_ref(),
            |db| state(db, key),
        )
    }
    pub fn native_readiness(&self) -> Result<Option<reverie_core::memory::MemoryReadiness>> {
        observed(
            self.connection.as_ref().ok_or(MemoryError::Closed)?,
            self.source.as_ref(),
            super::startup::readiness,
        )
    }
    pub fn bind(
        mut self,
        embedder: Arc<dyn Embedder>,
        decay_per_hour: f64,
    ) -> Result<MemoryReader> {
        let db = self.connection.take().ok_or(MemoryError::Closed)?;
        Ok(MemoryReader {
            connection: Mutex::new(Some(db)),
            source: Mutex::new(self.source.take()),
            embedder,
            decay_per_hour,
        })
    }
    pub fn close(&mut self) -> Result<()> {
        self.shutdown().into_result()
    }
    pub fn shutdown(&mut self) -> ShutdownStatus<MemoryError> {
        startup::shutdown_actual(&mut self.connection, self.source.as_mut())
    }
}
impl MemoryReader {
    pub fn embedder_name(&self) -> MetadataText {
        embedding_text(self.embedder.name())
    }
    /// Service-installed path and independently selected model. Ephemeral names
    /// cannot identify an existing database. No URI or immutable-WAL shortcut.
    pub fn open_with(
        path: impl AsRef<Path>,
        embedder: Arc<dyn Embedder>,
        decay_per_hour: f64,
    ) -> Result<Self> {
        MemoryReadProfile::open(path)?.bind(embedder, decay_per_hour)
    }
    /// Same ranking and embedding as the existing writer, with no touch/update.
    /// Inference happens before taking the SQLite connection mutex.
    pub fn retrieve_text(
        &self,
        text: EmbeddingText<'_>,
        options: RetrievalOptions<'_>,
    ) -> Result<Vec<Memory>> {
        let query = query::prepare_query(text, &options, self.embedder.as_ref())?;
        let candidates = self.session(|db| query::candidates(db, &query.model, &options))?;
        query::score(candidates, &query, &options, self.decay_per_hour)
    }
    pub fn retrieve(&self, text: &str, options: RetrievalOptions<'_>) -> Result<Vec<Memory>> {
        self.retrieve_text(EmbeddingText::from_scalar_text(text), options)
    }
    pub fn get_state(&self, key: &str) -> Result<Option<String>> {
        self.session(|db| state(db, key))
    }
    pub fn native_readiness(&self) -> Result<Option<reverie_core::memory::MemoryReadiness>> {
        self.session(super::startup::readiness)
    }
    fn session<T>(&self, run: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let connection = self.connection.lock().map_err(|_| MemoryError::Poisoned)?;
        let source = self.source.lock().map_err(|_| MemoryError::Poisoned)?;
        observed(
            connection.as_ref().ok_or(MemoryError::Closed)?,
            source.as_ref(),
            run,
        )
    }
    pub fn close(&self) -> Result<()> {
        self.shutdown().into_result()
    }
    pub fn shutdown(&self) -> ShutdownStatus<MemoryError> {
        let Ok(mut connection) = self.connection.lock() else {
            return ShutdownStatus::Pending(MemoryError::Poisoned);
        };
        let Ok(mut source) = self.source.lock() else {
            return ShutdownStatus::Pending(MemoryError::Poisoned);
        };
        startup::shutdown_actual(&mut connection, source.as_mut())
    }
    /// Finalize a failed convenience read; a refused SQLite close returns the
    /// actual reader inside the error, never an empty cleanup acknowledgement.
    pub fn finalize_error(self, primary: MemoryError) -> MemoryError {
        match self.shutdown() {
            ShutdownStatus::Complete => primary,
            ShutdownStatus::Refused(secondary) => {
                finalized::<()>(Err(primary), Err(secondary)).unwrap_err()
            }
            ShutdownStatus::Pending(secondary) => MemoryError::ReaderPending {
                primary: Box::new(finalized::<()>(Err(primary), Err(secondary)).unwrap_err()),
                reader: Box::new(self),
            },
        }
    }
}
impl std::fmt::Debug for MemoryReader {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("MemoryReader").finish_non_exhaustive()
    }
}
fn observed<T>(
    db: &Connection,
    source: Option<&startup::source::Source>,
    run: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    if let Some(source) = source {
        source.assert_identity(db)?;
    }
    let value = run(db)?;
    if let Some(source) = source {
        source.assert_identity(db)?;
    }
    Ok(value)
}
fn open_existing(path: &Path) -> Result<Connection> {
    let path = normalized_store_path(path);
    if is_memory_name(&path) {
        return Err(MemoryError::NotInitialized);
    }
    match std::fs::metadata(&path) {
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(MemoryError::NotInitialized);
        }
        Err(error) => return Err(error.into()),
    }
    let db = Connection::open_with_flags(
        sqlite_path(&path)?,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let checked = qualify(&db);
    if let Err(primary) = checked {
        return finalized(Err(primary), db.close().map_err(|(_, error)| error.into()));
    }
    Ok(db)
}
fn state(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM state WHERE key=?", [key], |row| {
            row.get(0)
        })
        .optional()?)
}
pub(super) fn qualify(db: &Connection) -> Result<()> {
    db.busy_timeout(Duration::from_secs(30))?;
    let mut statement = db.prepare("PRAGMA table_info(memories)")?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if names.is_empty() {
        return Err(MemoryError::NotInitialized);
    }
    if names.iter().any(|name| name == LEGACY_ASSISTANT_COLUMN) {
        return Err(MemoryError::NeedsMigration);
    }
    if !names.iter().any(|name| name == "assistant_text") {
        return Err(MemoryError::MissingAssistantColumn);
    }
    if db
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='state'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_none()
    {
        return Err(MemoryError::NotInitialized);
    }
    // Preparing the exact selected read identifies missing/partial schemas;
    // no CREATE, schema upgrade, WAL setting or write-compatible fallback.
    db.prepare("SELECT value FROM state WHERE key=?")?;
    db.prepare("SELECT id,kind,created_at,user_text,assistant_text,text,importance,importance_source,embed_model,embedding,source_ids,section,meta,last_accessed FROM memories")?;
    Ok(())
}
#[cfg(test)]
mod tests;
