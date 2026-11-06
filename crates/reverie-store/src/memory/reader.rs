//! Existing-memory observations. Opening never creates/migrates tables, selects
//! another model, imports history, seeds beliefs, or touches access timestamps.
use super::*;
use rusqlite::OptionalExtension;

pub struct MemoryReader {
    connection: Mutex<Option<Connection>>,
    embedder: Arc<dyn Embedder>,
    decay_per_hour: f64,
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
        let path = normalized_store_path(path.as_ref());
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
        Ok(Self {
            connection: Mutex::new(Some(db)),
            embedder,
            decay_per_hour,
        })
    }
    /// Same ranking and embedding as the existing writer, with no touch/update.
    /// Inference happens before taking the SQLite connection mutex.
    pub fn retrieve_text(
        &self,
        text: EmbeddingText<'_>,
        options: RetrievalOptions<'_>,
    ) -> Result<Vec<Memory>> {
        let query = query::prepare_query(text, &options, self.embedder.as_ref())?;
        let connection = self.connection.lock().map_err(|_| MemoryError::Poisoned)?;
        let db = connection.as_ref().ok_or(MemoryError::Closed)?;
        let candidates = query::candidates(db, &query.model, &options)?;
        drop(connection);
        query::score(candidates, &query, &options, self.decay_per_hour)
    }
    pub fn retrieve(&self, text: &str, options: RetrievalOptions<'_>) -> Result<Vec<Memory>> {
        self.retrieve_text(EmbeddingText::from_scalar_text(text), options)
    }
    pub fn get_state(&self, key: &str) -> Result<Option<String>> {
        let connection = self.connection.lock().map_err(|_| MemoryError::Poisoned)?;
        let db = connection.as_ref().ok_or(MemoryError::Closed)?;
        Ok(db
            .query_row("SELECT value FROM state WHERE key=?", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }
    pub fn close(&self) -> Result<()> {
        let mut connection = self.connection.lock().map_err(|_| MemoryError::Poisoned)?;
        if let Some(db) = connection.take()
            && let Err((db, error)) = db.close()
        {
            *connection = Some(db);
            return Err(error.into());
        }
        Ok(())
    }
}
fn qualify(db: &Connection) -> Result<()> {
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
