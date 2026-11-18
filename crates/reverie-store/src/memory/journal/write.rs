use super::{JournalKey, JournalReceipt, lookup};
use crate::memory::{MemoryError, MemoryStore, Result, error::finalized};
use reverie_contracts::memory::channel::journal::JournalCommit;
use rusqlite::{Connection, OptionalExtension, params};
use std::time::Duration;

const SCHEMA: &str = include_str!("schema.sql");

pub struct JournalWriteReceipt {
    pub entry_id: i64,
    pub replayed: bool,
}

impl MemoryStore {
    /// Persist the checked commit in the existing Hands tables. The caller
    /// has already verified current membership and the cited Office messages.
    pub fn commit_journal(
        &self,
        request: &JournalCommit,
        previous_id: Option<i64>,
        now_ms: f64,
    ) -> Result<Option<JournalWriteReceipt>> {
        if !now_ms.is_finite() || now_ms < 0.0 {
            return Err(MemoryError::Integrity);
        }
        self.session(|tx| {
            if !tx.db.is_autocommit() {
                return Err(MemoryError::ActiveTransaction);
            }
            let previous: u32 = tx
                .db
                .pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
            tx.db.busy_timeout(Duration::from_secs(1))?;
            let result = tx.own_transaction(|tx| {
                tx.db.execute_batch("BEGIN IMMEDIATE")?;
                tx.db.execute_batch(SCHEMA)?;
                commit(tx.db, request, previous_id, now_ms)
            });
            finalized(
                result,
                tx.db
                    .busy_timeout(Duration::from_millis(previous.into()))
                    .map_err(Into::into),
            )
        })
    }
}

fn commit(
    db: &Connection,
    request: &JournalCommit,
    previous_id: Option<i64>,
    now_ms: f64,
) -> Result<Option<JournalWriteReceipt>> {
    let key = JournalKey::Turn(request.turn_id().clone());
    match lookup(db, &key, Some(request.digest()))? {
        JournalReceipt::Committed { entry_id, .. } => {
            return Ok(Some(JournalWriteReceipt {
                entry_id,
                replayed: true,
            }));
        }
        JournalReceipt::Conflict => return Ok(None),
        JournalReceipt::Missing => (),
    }
    if !checkpoint_allows(db, request, previous_id)? || !targets_exist(db, request, now_ms)? {
        return Ok(None);
    }
    let entry_id = insert(db, request, now_ms)?;
    Ok(Some(JournalWriteReceipt {
        entry_id,
        replayed: false,
    }))
}

fn checkpoint_allows(
    db: &Connection,
    request: &JournalCommit,
    previous_id: Option<i64>,
) -> Result<bool> {
    let latest = db
        .query_row(
            "SELECT id, end_at, turn_id FROM hands_journal ORDER BY id DESC LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(match latest {
        Some((id, at, turn)) => previous_id == Some(id) && request.follows(at, &turn),
        None => previous_id.is_none(),
    })
}

fn targets_exist(db: &Connection, request: &JournalCommit, now_ms: f64) -> Result<bool> {
    let mut read = db.prepare("SELECT end_at, committed_ms FROM hands_journal WHERE id=?")?;
    for target in request.targets() {
        let point = read
            .query_row([target], |row| {
                Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?))
            })
            .optional()?;
        if !point.is_some_and(|(at, committed)| {
            request.covers_target(at) && committed.is_finite() && committed <= now_ms
        }) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn insert(db: &Connection, request: &JournalCommit, now_ms: f64) -> Result<i64> {
    db.execute(
        "INSERT INTO hands_journal(turn_id, committed_ms, payload_hash, payload, end_at) VALUES(?,?,?,?,?)",
        params![request.turn_id().as_str(), now_ms, request.digest().as_str(), request.payload(), request.end_at()],
    )?;
    let id = db.last_insert_rowid();
    db.execute(
        "INSERT INTO hands_journal_fts(rowid,text) VALUES(?,?)",
        params![id, request.index_text()],
    )?;
    let mut link =
        db.prepare("INSERT INTO hands_journal_links(superseding_id,target_id) VALUES(?,?)")?;
    for target in request.supersedes() {
        link.execute(params![id, target])?;
    }
    Ok(id)
}
