//! Named native startup storage. Application owns migration/profile workflow;
//! this owner validates and persists a closed namespace on one retained source.
//! The installer must quiesce legacy/raw SQLite writers before adoption. Its
//! actual lifecycle flock stays held through preflight, admission and shutdown.
mod metadata;
pub(super) mod source;
#[cfg(test)]
mod tests;
use super::*;
use metadata::Observed;
use reverie_core::{
    memory::{MemoryReadiness, MemoryStartupPhase},
    shutdown::ShutdownStatus,
};
use rusqlite::config::DbConfig;

#[derive(Clone, Copy, Eq, PartialEq)]
enum Stage {
    Open,
    Checked,
    Admitted,
    Refused,
    Closed,
}

#[must_use = "retain the actual startup source/connection and explicitly shut it down"]
pub struct MemoryStartupStore {
    store: MemoryStore,
    source: source::Source,
    observed: Option<Observed>,
    stage: Stage,
    consumed_refusal: bool,
}
impl std::fmt::Debug for MemoryStartupStore {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output
            .debug_struct("MemoryStartupStore")
            .finish_non_exhaustive()
    }
}
impl MemoryStartupStore {
    /// Opens no writable SQLite handle. Configuration supplies the path;
    /// neither this constructor nor metadata success grants startup authority.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = normalized_store_path(path.as_ref());
        if is_memory_name(&path) {
            return Err(MemoryError::ReadinessRecoveryRequired);
        }
        let mut source = source::Source::capture(&path)?;
        let opened = if source.exists() {
            source
                .preflight_uri()
                .and_then(|uri| {
                    Connection::open_with_flags(
                        uri,
                        OpenFlags::SQLITE_OPEN_READ_ONLY
                            | OpenFlags::SQLITE_OPEN_URI
                            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                    )
                    .map_err(Into::into)
                })
                .map(Some)
        } else {
            Ok(None)
        };
        let db = match opened {
            Ok(db) => db,
            Err(primary) => return finalized(Err(primary), source.close()),
        };
        Ok(Self {
            store: MemoryStore {
                path,
                connection: Mutex::new(db),
                embedder: RwLock::new(Arc::new(HashedEmbedder::default())),
                decay_per_hour: 0.995,
                startup_source: Mutex::new(None),
            },
            source,
            observed: None,
            stage: Stage::Open,
            consumed_refusal: false,
        })
    }
    /// The application adopts this owner before calling preflight, so failed
    /// observations/configuration/close cannot drop an actual SQLite handle.
    pub fn preflight(&mut self) -> Result<()> {
        if self.stage != Stage::Open {
            return Err(MemoryError::ReadinessUnconfirmed);
        }
        self.source.assert_unchanged()?;
        let db = self
            .store
            .connection
            .get_mut()
            .map_err(|_| MemoryError::Poisoned)?;
        let observed = (|| {
            if let Some(db) = db {
                db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
                db.busy_timeout(Duration::from_secs(30))?;
                self.source.assert_identity(db)?;
                readonly_observation(db)
            } else {
                Ok(Observed::Legacy)
            }
        })();
        // Observe generation/sidecar drift even when the SQL observation
        // refused. Root fchown or a non-quiesced RW node must not be hidden by
        // the earlier collision/format error.
        let observed = finalized(observed, self.source.assert_unchanged())?;
        self.observed = Some(observed);
        self.stage = Stage::Checked;
        Ok(())
    }
    /// Called only after read-only preflight and actual backend selection.
    /// No embedding is performed with the unopened owner's provisional value.
    pub fn admit(&mut self, embedder: Arc<dyn Embedder>, decay_per_hour: f64) -> Result<()> {
        if self.stage != Stage::Checked {
            return Err(MemoryError::ReadinessUnconfirmed);
        }
        match self.admit_inner(embedder, decay_per_hour) {
            Ok(state) => {
                self.observed = Some(Observed::Native(state));
                self.stage = Stage::Admitted;
                Ok(())
            }
            Err(error) => {
                self.stage = Stage::Refused;
                Err(error)
            }
        }
    }
    fn admit_inner(&mut self, embedder: Arc<dyn Embedder>, decay: f64) -> Result<MemoryReadiness> {
        self.store.close()?;
        self.source.assert_unchanged()?;
        if !self.source.exists() {
            self.source.create()?;
        }
        let opened = Connection::open_with_flags(
            self.source.writer_uri()?,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        *self
            .store
            .connection
            .get_mut()
            .map_err(|_| MemoryError::Poisoned)? = Some(opened);
        let db = self
            .store
            .connection
            .get_mut()
            .map_err(|_| MemoryError::Poisoned)?
            .as_mut()
            .ok_or(MemoryError::Closed)?;
        db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
        self.source.assert_identity(db)?;
        self.source.assert_unchanged()?;
        configure_connection(db)?;
        #[cfg(test)]
        crate::faults::hit(
            crate::faults::Point::MemoryStartupBeforeWriter,
            &self.store.path,
        )?;
        let expected = self
            .observed
            .as_ref()
            .ok_or(MemoryError::ReadinessUnconfirmed)?;
        let state = begin_admission(db, expected)?;
        self.source.assert_identity(db)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, false)?;
        self.store.set_embedder(embedder)?;
        self.store.decay_per_hour = decay;
        Ok(state)
    }
    pub fn store(&self) -> Result<&MemoryStore> {
        if self.stage != Stage::Admitted {
            return Err(MemoryError::ReadinessUnconfirmed);
        }
        Ok(&self.store)
    }
    pub fn profile_pending(&mut self) -> Result<()> {
        self.publish(
            MemoryReadiness::try_new(MemoryStartupPhase::ProfilePending, None)
                .map_err(|_| MemoryError::MalformedReadinessMetadata)?,
        )
    }
    pub fn ready(&mut self) -> Result<()> {
        let model = self
            .store()?
            .embedder_name()?
            .scalar_text()
            .ok_or(EmbeddingError::InvalidText)?;
        self.publish(
            MemoryReadiness::try_new(MemoryStartupPhase::Ready, Some(model))
                .map_err(|_| MemoryError::MalformedReadinessMetadata)?,
        )
    }
    fn publish(&mut self, next: MemoryReadiness) -> Result<()> {
        self.store()?;
        let Some(Observed::Native(expected)) = &self.observed else {
            return Err(MemoryError::ReadinessUnconfirmed);
        };
        if !expected.can_publish(next.phase()) {
            return Err(MemoryError::ReadinessChanged);
        }
        let published = self.store.atomic_immediate(|tx| {
            self.source.assert_identity(tx.db)?;
            metadata::publish(tx.db, expected, &next)
        });
        match published {
            Ok(()) => {
                self.observed = Some(Observed::Native(next));
                Ok(())
            }
            Err(error) => {
                self.stage = Stage::Refused;
                Err(error)
            }
        }
    }
    /// Pending means an actual connection remains owned. A consumed file-close
    /// refusal is negative forever, never converted into a cleanup receipt.
    pub fn shutdown(&mut self) -> ShutdownStatus<MemoryError> {
        self.stage = Stage::Refused;
        let result = match self.store.connection.get_mut() {
            Ok(connection) => shutdown_actual(connection, Some(&mut self.source)),
            Err(_) => ShutdownStatus::Pending(MemoryError::Poisoned),
        };
        match result {
            ShutdownStatus::Pending(error) => return ShutdownStatus::Pending(error),
            ShutdownStatus::Refused(error) => {
                self.consumed_refusal = true;
                return ShutdownStatus::Refused(error);
            }
            ShutdownStatus::Complete => (),
        }
        self.stage = Stage::Closed;
        if self.consumed_refusal {
            ShutdownStatus::Refused(MemoryError::ReadinessUnconfirmed)
        } else {
            ShutdownStatus::Complete
        }
    }
    pub fn close(&mut self) -> Result<()> {
        self.shutdown().into_result()
    }
    /// Transfer the same actual database/source into the existing store only
    /// after this application's ready publication. A refused transfer returns
    /// its complete owner; the caller must retain and shut it down.
    pub fn into_ready(mut self) -> std::result::Result<MemoryStore, Box<Self>> {
        if self.stage != Stage::Admitted
            || !matches!(&self.observed, Some(Observed::Native(value)) if value.phase()==MemoryStartupPhase::Ready)
            || self.store.startup_source.get_mut().is_err()
        {
            return Err(Box::new(self));
        }
        *self
            .store
            .startup_source
            .get_mut()
            .expect("checked owned mutex") = Some(self.source);
        Ok(self.store)
    }
}
fn readonly_observation(db: &Connection) -> Result<Observed> {
    metadata::observe(db).map_err(|error| match &error {
        MemoryError::Sqlite(rusqlite::Error::SqliteFailure(code, _))
            if matches!(
                code.code,
                rusqlite::ErrorCode::ReadOnly | rusqlite::ErrorCode::CannotOpen
            ) =>
        {
            MemoryError::ReadinessObservationUnavailable(Box::new(error))
        }
        _ => error,
    })
}
fn begin_admission(db: &Connection, expected: &Observed) -> Result<MemoryReadiness> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    let initialized = (|| {
        if &metadata::observe(db)? != expected {
            return Err(MemoryError::ReadinessChanged);
        }
        db.execute_batch(SCHEMA)?;
        migrate_connection(db)?;
        metadata::initializing(db, expected)
    })();
    match initialized {
        Ok(state) => match db.execute_batch("COMMIT") {
            Ok(()) => Ok(state),
            Err(error) => finalized(Err(error.into()), rollback(db)),
        },
        Err(error) => finalized(Err(error), rollback(db)),
    }
}
fn rollback(db: &Connection) -> Result<()> {
    if !db.is_autocommit() {
        db.execute_batch("ROLLBACK")?;
    }
    Ok(())
}
pub(super) fn shutdown_actual(
    connection: &mut Option<Connection>,
    mut source: Option<&mut source::Source>,
) -> ShutdownStatus<MemoryError> {
    let mut checked = Ok(());
    if let (Some(db), Some(source)) = (connection.as_ref(), source.as_deref_mut()) {
        checked = source.assert_identity(db);
        if checked.is_err() {
            source.refuse();
            checked = finalized(
                checked,
                db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
                    .map(|_| ())
                    .map_err(Into::into),
            );
        }
    }
    if let Some(db) = connection.take()
        && let Err((db, error)) = db.close()
    {
        *connection = Some(db);
        return ShutdownStatus::Pending(finalized::<()>(checked, Err(error.into())).unwrap_err());
    }
    let result = finalized(checked, source.map_or(Ok(()), source::Source::close));
    match result {
        Ok(()) => ShutdownStatus::Complete,
        Err(error) => ShutdownStatus::Refused(error),
    }
}
pub(super) fn readiness(db: &Connection) -> Result<Option<MemoryReadiness>> {
    let mut moved = 1;
    db.file_control(Some("main"), rusqlite::FileControl::HasMoved(&mut moved))?;
    if moved != 0 {
        return Err(MemoryError::ReadinessChanged);
    }
    Ok(match readonly_observation(db)? {
        Observed::Legacy => None,
        Observed::Native(state) => Some(state),
    })
}
pub(super) fn capture_reader(path: &Path) -> Result<(Connection, source::Source)> {
    let mut source = source::Source::capture(path)?;
    if !source.exists() {
        return finalized(Err(MemoryError::NotInitialized), source.close());
    }
    let uri = match source.recall_uri() {
        Ok(uri) => uri,
        Err(primary) => return finalized(Err(primary), source.close()),
    };
    let opened = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    );
    let db = match opened {
        Ok(db) => db,
        Err(error) => return finalized(Err(error.into()), source.close()),
    };
    // No fallible qualification follows open until an application has adopted
    // this same connection and its O_PATH source anchors together.
    Ok((db, source))
}
