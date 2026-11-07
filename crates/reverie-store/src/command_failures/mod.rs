//! Dedicated legacy hands telemetry SQLite store. No command execution, owner
//! authority, CompanyStore/memory/effect ledger or pathname-create fallback.
mod calls;
mod custody;
pub use calls::{LearningLogCall, LearningLogs};
mod error;
mod records;
#[cfg(test)]
mod tests;
pub use error::{FailureStoreError, RetainedConnection};
use error::{Result, finalized, need};
use reverie_core::{
    command_telemetry::{
        FAILURE_CLOCK_MAX, FAILURE_COUNTER_MAX, FAILURE_PROVENANCE, FailureEvent, FailureReport,
    },
    ids::ProfileEmployeeId,
    worker_options::TelemetryKey,
};
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU32, Ordering},
};
#[derive(Clone, Copy)]
enum OpenPurpose {
    CreateHands,
    ExistingHands,
}
struct FailureLog {
    directory: PathBuf,
    directory_id: custody::Identity,
    file_id: custody::Identity,
    uid: u32,
    employee: ProfileEmployeeId,
    keys: Vec<TelemetryKey>,
    dropped: AtomicU32,
}
impl FailureLog {
    fn open(
        directory: &Path,
        employee: &ProfileEmployeeId,
        keys: &[TelemetryKey],
        uid: u32,
        purpose: OpenPurpose,
    ) -> Result<Self> {
        reverie_core::command_telemetry::TelemetryConfiguration::try_new(false, keys.to_vec())
            .map_err(|_| FailureStoreError::Refused)?;
        let (directory_id, file_id) = custody::capture(directory, uid, purpose)?;
        let log = Self {
            directory: directory.to_owned(),
            directory_id,
            file_id,
            uid,
            employee: employee.clone(),
            keys: keys.to_vec(),
            dropped: AtomicU32::new(0),
        };
        log.with_database(|db| log.initialize(db))?;
        log.with_database(|db|{
            db.execute_batch("CREATE TABLE IF NOT EXISTS telemetry_origin (id INTEGER PRIMARY KEY CHECK(id=1), provenance TEXT NOT NULL)")?;
            transaction(db,"BEGIN DEFERRED",|db|{
                db.execute("INSERT OR IGNORE INTO telemetry_origin VALUES (1,?)",[FAILURE_PROVENANCE])?;
                let provenance:String=db.query_row("SELECT provenance FROM telemetry_origin WHERE id=1",[],|row|row.get(0))?;
                need(provenance==FAILURE_PROVENANCE)
            })
        })?;
        Ok(log)
    }
    fn initialize(&self, db: &Connection) -> Result<()> {
        db.execute_batch("CREATE TABLE IF NOT EXISTS failures (execution TEXT PRIMARY KEY, t INTEGER NOT NULL, employee TEXT NOT NULL, harness TEXT NOT NULL, tool TEXT NOT NULL, exit INTEGER NOT NULL, category TEXT NOT NULL);CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), employee TEXT NOT NULL, harness TEXT NOT NULL)")?;
        transaction(db, "BEGIN DEFERRED", |db| {
            db.execute(
                "INSERT OR IGNORE INTO binding VALUES (1,?,'hands')",
                [self.employee.as_str()],
            )?;
            let binding: (String, String) = db.query_row(
                "SELECT employee,harness FROM binding WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            need(binding == (self.employee.as_str().to_owned(), "hands".to_owned()))?;
            db.execute_batch("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);INSERT OR IGNORE INTO counters VALUES ('evicted',0);INSERT OR IGNORE INTO counters VALUES ('expired',0)")?;
            Ok(())
        })
    }
    /// Host time is supplied by the actual clock owner, never event text.
    fn observe(&self, event: &FailureEvent, now: u64) -> Result<bool> {
        if !event.tool().selected(&self.keys) || now > FAILURE_CLOCK_MAX {
            return Ok(false);
        }
        let result = self.with_database(|db| {
            transaction(db, "BEGIN IMMEDIATE", |db| self.insert(db, event, now))
        });
        if result.is_err() {
            let _ = self
                .dropped
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                    Some(n.saturating_add(1).min(FAILURE_COUNTER_MAX))
                });
        }
        result
    }
    fn report(&self, now: u64) -> Result<FailureReport> {
        need(now <= FAILURE_CLOCK_MAX)?;
        self.with_database(|db| transaction(db, "BEGIN IMMEDIATE", |db| self.read_report(db, now)))
    }
}
fn transaction<T>(
    db: &Connection,
    begin: &str,
    operation: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    db.execute_batch(begin)?;
    match operation(db) {
        Ok(value) => match db.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => finalized(
                Err(error.into()),
                db.execute_batch("ROLLBACK").map_err(Into::into),
            ),
        },
        Err(error) => finalized(Err(error), db.execute_batch("ROLLBACK").map_err(Into::into)),
    }
}
