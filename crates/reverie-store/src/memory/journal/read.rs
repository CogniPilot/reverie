use super::table_exists;
use crate::memory::Result;
use rusqlite::{Connection, OptionalExtension, Row, params};

pub const PAGE_SIZE: u16 = 4;
pub const CORRECTION_LIMIT: u16 = 2;
const RECALL_POOL: u16 = 20;

pub struct JournalRow {
    pub id: i64,
    pub committed_ms: f64,
    pub payload: String,
}

pub struct JournalCheckpoint {
    pub id: i64,
    pub turn_id: String,
    pub committed_ms: f64,
    pub end_at: f64,
}

#[derive(Default)]
pub struct JournalReader<'db> {
    db: Option<&'db Connection>,
}

impl<'db> JournalReader<'db> {
    pub(crate) fn observe<T>(
        db: &Connection,
        run: impl FnOnce(&JournalReader<'_>) -> Result<T>,
    ) -> Result<T> {
        let snapshot = db.unchecked_transaction()?;
        let window = JournalReader {
            db: table_exists(&snapshot)?.then_some(&*snapshot),
        };
        let result = run(&window)?;
        snapshot.commit()?;
        Ok(result)
    }

    pub fn checkpoint(&self) -> Result<Option<JournalCheckpoint>> {
        let Some(db) = self.db else { return Ok(None) };
        Ok(db.query_row(
            "SELECT id, turn_id, committed_ms, end_at FROM hands_journal ORDER BY id DESC LIMIT 1",
            [], |row| Ok(JournalCheckpoint { id: row.get(0)?, turn_id: row.get(1)?, committed_ms: row.get(2)?, end_at: row.get(3)? }),
        ).optional()?)
    }

    pub fn ceiling(&self) -> Result<i64> {
        let Some(db) = self.db else { return Ok(0) };
        Ok(
            db.query_row("SELECT coalesce(max(id),0) FROM hands_journal", [], |row| {
                row.get(0)
            })?,
        )
    }

    pub fn recall_candidates(&self, expression: &str) -> Result<Vec<(JournalRow, f64)>> {
        let Some(db) = self.db else {
            return Ok(Vec::new());
        };
        let mut statement = db.prepare(
            "SELECT j.id,j.committed_ms,j.payload,rank FROM hands_journal_fts f
              JOIN hands_journal j ON j.id=f.rowid WHERE hands_journal_fts MATCH ?
              ORDER BY rank,j.id DESC LIMIT ?",
        )?;
        let rows = statement.query_map(params![expression, RECALL_POOL], |row| {
            Ok((record(row)?, row.get(3)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn corrections(&self, target: i64, as_of: Option<f64>) -> Result<Vec<JournalRow>> {
        let Some(db) = self.db else {
            return Ok(Vec::new());
        };
        let mut statement = db.prepare(
            "SELECT j.id,j.committed_ms,j.payload FROM hands_journal_links l
              JOIN hands_journal j ON j.id=l.superseding_id WHERE l.target_id=?
              AND (?2 IS NULL OR j.committed_ms<=?2) ORDER BY j.id DESC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![target, as_of, CORRECTION_LIMIT + 1], record)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn page(
        &self,
        ceiling: i64,
        before: Option<i64>,
        as_of: Option<f64>,
        expression: Option<&str>,
    ) -> Result<Vec<JournalRow>> {
        let Some(db) = self.db else {
            return Ok(Vec::new());
        };
        let mut statement = db.prepare(
            "SELECT j.id,j.committed_ms,j.payload FROM hands_journal j WHERE j.id<=?1
              AND (?2 IS NULL OR j.id<?2) AND (?3 IS NULL OR j.committed_ms<=?3)
              AND (?4 IS NULL OR j.id IN (SELECT rowid FROM hands_journal_fts WHERE hands_journal_fts MATCH ?4))
              ORDER BY j.id DESC LIMIT ?5",
        )?;
        let rows = statement.query_map(
            params![ceiling, before, as_of, expression, PAGE_SIZE + 1],
            record,
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

fn record(row: &Row<'_>) -> rusqlite::Result<JournalRow> {
    Ok(JournalRow {
        id: row.get(0)?,
        committed_ms: row.get(1)?,
        payload: row.get(2)?,
    })
}
