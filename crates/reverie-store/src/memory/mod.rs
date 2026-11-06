//! Existing SQLite memory persistence; no operator CLI or raw SQL API.
mod backup;
mod beliefs;
mod claims;
mod error;
mod query;
#[cfg(test)]
mod tests;
mod writes;
use error::finalized;
pub use error::{MemoryError, Result};
pub use query::RetrievalOptions;
use reverie_contracts::memory::embedding_text;
pub use reverie_contracts::memory::{Memory, MemoryMetadata, MemorySources};
use reverie_contracts::storage_identity::MetadataText;
pub use reverie_core::memory::Belief;
use reverie_core::memory::{Embedder, HashedEmbedder};
use reverie_core::memory::{EmbeddingError, EmbeddingText};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub use writes::{DreamInput, EpisodeInput, ReflectionInput};
pub const SCHEMA_VERSION: i64 = 1;
const SCHEMA: &str = include_str!("schema.sql");
const LEGACY_ASSISTANT_COLUMN: &str = "\x6a\x69\x6e\x78\x5f\x74\x65\x78\x74";

pub struct MemoryStore {
    path: PathBuf,
    connection: Mutex<Option<Connection>>,
    embedder: RwLock<Arc<dyn Embedder>>,
    decay_per_hour: f64,
}
pub struct MemoryTransaction<'a> {
    db: &'a Connection,
    embedder: &'a dyn Embedder,
    decay: f64,
    depth: usize,
}
impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(path, Arc::new(HashedEmbedder::default()), 0.995)
    }
    pub fn open_with(
        path: impl AsRef<Path>,
        embedder: Arc<dyn Embedder>,
        decay_per_hour: f64,
    ) -> Result<Self> {
        let path = normalized_store_path(path.as_ref());
        if !is_memory_name(&path)
            && let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        // The bundled SQLite enables URI filenames globally. Absolute physical
        // spelling prevents that interpretation, matching the frozen Python
        // connect(uri=False), without changing process-global SQLite settings.
        // This store retains ordinary SQLite custody, not profile-store rules.
        let mut db = Connection::open_with_flags(
            sqlite_path(&path)?,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let initialized = (|| {
            configure_connection(&db)?;
            if !is_memory_name(&path) {
                db.pragma_update(None, "journal_mode", "WAL")?;
            }
            db.execute_batch(SCHEMA)?;
            migrate(&mut db)
        })();
        if let Err(primary) = initialized {
            let close = db.close().map_err(|(_, e)| MemoryError::from(e));
            return finalized(Err(primary), close);
        }
        Ok(Self {
            path,
            connection: Mutex::new(Some(db)),
            embedder: RwLock::new(embedder),
            decay_per_hour,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn embedder_name(&self) -> Result<MetadataText> {
        Ok(embedding_text(
            self.embedder
                .read()
                .map_err(|_| MemoryError::Poisoned)?
                .name(),
        ))
    }
    pub fn set_embedder(&self, embedder: Arc<dyn Embedder>) -> Result<()> {
        *self.embedder.write().map_err(|_| MemoryError::Poisoned)? = embedder;
        Ok(())
    }
    fn current_embedder(&self) -> Result<Arc<dyn Embedder>> {
        Ok(Arc::clone(
            &*self.embedder.read().map_err(|_| MemoryError::Poisoned)?,
        ))
    }
    fn session<T>(&self, run: impl FnOnce(&mut MemoryTransaction<'_>) -> Result<T>) -> Result<T> {
        let embedder = self.current_embedder()?;
        let connection = self.connection.lock().map_err(|_| MemoryError::Poisoned)?;
        let db = connection.as_ref().ok_or(MemoryError::Closed)?;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(&mut MemoryTransaction {
                db,
                embedder: embedder.as_ref(),
                decay: self.decay_per_hour,
                depth: 0,
            })
        }));
        // Release the SQLite mutex normally before propagating a Rust panic;
        // an owning atomic scope has already attempted rollback.
        drop(connection);
        match result {
            Ok(result) => result,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }
    /// Reentrant through the transaction argument. Only the outermost atomic
    /// joins/commits/rolls back; legacy explicitly-committing operations retain
    /// that behavior even inside this block.
    pub fn atomic<T>(
        &self,
        run: impl FnOnce(&mut MemoryTransaction<'_>) -> Result<T>,
    ) -> Result<T> {
        self.session(|session| session.atomic(run))
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
    /// Consistent SQLite online backup of every table, including later stores'
    /// tables, IDs and original vector BLOBs. Trusted application paths only.
    pub fn backup_to(&self, path: impl AsRef<Path>) -> Result<()> {
        self.session(|session| backup::backup_to(session.db, path.as_ref()))
    }
    /// The installing application authorizes a selected snapshot and quiesces
    /// other writers. Qualification/migration happens on a private SQLite
    /// temporary before the destination is changed; vectors are never rebuilt.
    pub fn restore_from(&self, path: impl AsRef<Path>) -> Result<()> {
        let mut connection = self.connection.lock().map_err(|_| MemoryError::Poisoned)?;
        let db = connection.as_mut().ok_or(MemoryError::Closed)?;
        if !db.is_autocommit() {
            return Err(MemoryError::ActiveTransaction);
        }
        backup::restore_from(db, path.as_ref())
    }
}
fn migrate(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let columns = {
        let mut statement = tx.prepare("PRAGMA table_info(memories)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if columns.iter().any(|name| name == LEGACY_ASSISTANT_COLUMN) {
        if columns.iter().any(|name| name == "assistant_text") {
            return Err(MemoryError::AmbiguousAssistantColumns);
        }
        tx.execute_batch(&format!(
            "ALTER TABLE memories RENAME COLUMN \"{LEGACY_ASSISTANT_COLUMN}\" TO assistant_text"
        ))?;
    } else if !columns.iter().any(|name| name == "assistant_text") {
        return Err(MemoryError::MissingAssistantColumn);
    }
    let version: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version < SCHEMA_VERSION {
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    tx.commit()?;
    Ok(())
}
impl MemoryTransaction<'_> {
    fn begin_write(&self) -> Result<()> {
        if self.db.is_autocommit() {
            self.db.execute_batch("BEGIN DEFERRED")?;
        }
        Ok(())
    }
    fn commit(&self) -> Result<()> {
        if !self.db.is_autocommit() {
            self.db.execute_batch("COMMIT")?;
        }
        Ok(())
    }
    fn rollback(&self) -> Result<()> {
        if !self.db.is_autocommit() {
            self.db.execute_batch("ROLLBACK")?;
        }
        Ok(())
    }
    fn commit_if_outer(&self) -> Result<()> {
        if self.depth == 0 {
            self.commit()?;
        }
        Ok(())
    }
    pub fn atomic<T>(&mut self, run: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        self.transaction_scope(run, false)
    }
    fn transaction_scope<T>(
        &mut self,
        run: impl FnOnce(&mut Self) -> Result<T>,
        rollback_failed_commit: bool,
    ) -> Result<T> {
        self.depth += 1;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(self)));
        let outer = self.depth == 1;
        self.depth -= 1;
        let result = match result {
            Ok(result) => result,
            Err(payload) => {
                if outer && let Err(error) = self.rollback() {
                    std::panic::panic_any(MemoryError::RollbackAfterPanic(Box::new(error)));
                }
                std::panic::resume_unwind(payload)
            }
        };
        if !outer {
            return result;
        }
        match result {
            Ok(value) => match self.commit() {
                Ok(()) => Ok(value),
                Err(error) if rollback_failed_commit => finalized(Err(error), self.rollback()),
                Err(error) => Err(error),
            },
            Err(error) => finalized(Err(error), self.rollback()),
        }
    }
    fn own_transaction<T>(&mut self, run: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        if self.depth > 0 {
            return run(self);
        }
        // sqlite3.Connection.__exit__ rolls back a failed COMMIT. The public
        // atomic context instead leaves that transaction open, as its source
        // commits in the context manager's else clause.
        self.transaction_scope(run, true)
    }
}
fn now() -> f64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64(),
        Err(e) => -e.duration().as_secs_f64(),
    }
}
fn is_memory_name(path: &Path) -> bool {
    use std::path::Component;
    let mut parts = path.components().filter(|part| *part != Component::CurDir);
    parts.next() == Some(Component::Normal(std::ffi::OsStr::new(":memory:")))
        && parts.next().is_none()
}
fn normalized_store_path(path: &Path) -> PathBuf {
    if is_memory_name(path) {
        PathBuf::from(":memory:")
    } else if path.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        path.to_owned()
    }
}
fn sqlite_path(path: &Path) -> Result<PathBuf> {
    if is_memory_name(path) {
        Ok(PathBuf::from(":memory:"))
    } else {
        Ok(std::path::absolute(path)?)
    }
}
fn configure_connection(db: &Connection) -> Result<()> {
    // Frozen legacy sqlite3.connect defaults differ from bundled SQLite's
    // foreign-key and secure-delete build defaults. Keep them connection-local
    // so existing extension tables and deleted-memory privacy do not change.
    db.busy_timeout(Duration::from_secs(30))?;
    for (name, value) in [
        ("foreign_keys", 0),
        ("recursive_triggers", 0),
        ("secure_delete", 1),
        ("legacy_alter_table", 0),
        ("trusted_schema", 1),
        ("synchronous", 2),
        ("temp_store", 0),
    ] {
        db.pragma_update(None, name, value)?;
    }
    Ok(())
}
