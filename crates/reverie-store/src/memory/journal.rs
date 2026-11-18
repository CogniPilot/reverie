//! Lookup of original Hands journal receipts in the room-memory database.
use super::{MemoryError, Result};
use reverie_contracts::memory::channel::journal::journal_digest;
use reverie_core::{ids::ChatMessageId, operations::JournalDigest};
use rusqlite::{Connection, OptionalExtension, Row};
mod write;
pub use write::JournalWriteReceipt;

#[derive(Clone, Copy)]
pub struct JournalEntryId(i64);

impl JournalEntryId {
    pub fn new(value: i64) -> Option<Self> {
        (1..1_000_000_000).contains(&value).then_some(Self(value))
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

pub enum JournalKey {
    Entry(JournalEntryId),
    Turn(ChatMessageId),
}

pub enum JournalReceipt {
    Missing,
    Conflict,
    Committed {
        turn_id: ChatMessageId,
        entry_id: i64,
        committed_ms: f64,
        digest: JournalDigest,
    },
}

pub(super) fn receipt(
    db: &Connection,
    key: &JournalKey,
    expected: Option<&JournalDigest>,
) -> Result<JournalReceipt> {
    let snapshot = db.unchecked_transaction()?;
    let exists = snapshot
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='hands_journal'",
            [],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_none() {
        snapshot.commit()?;
        return Ok(JournalReceipt::Missing);
    }
    let result = lookup(&snapshot, key, expected)?;
    snapshot.commit()?;
    Ok(result)
}

fn lookup(
    db: &Connection,
    key: &JournalKey,
    expected: Option<&JournalDigest>,
) -> Result<JournalReceipt> {
    let result = match key {
        JournalKey::Entry(id) => db.query_row(
            "SELECT id,turn_id,committed_ms,payload_hash,payload FROM hands_journal WHERE id=?",
            [id.get()],
            |row| project(row, expected),
        ),
        JournalKey::Turn(id) => db.query_row(
            "SELECT id,turn_id,committed_ms,payload_hash,payload FROM hands_journal WHERE turn_id=?",
            [id.as_str()],
            |row| project(row, expected),
        ),
    }.optional()?;
    result.unwrap_or(Ok(JournalReceipt::Missing))
}

fn project(
    row: &Row<'_>,
    expected: Option<&JournalDigest>,
) -> rusqlite::Result<Result<JournalReceipt>> {
    let stored: String = row.get("payload_hash")?;
    let payload = row.get_ref("payload")?.as_str().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let digest = journal_digest(payload);
    if stored != digest.as_str() || expected.is_some_and(|expected| expected != &digest) {
        return Ok(Ok(JournalReceipt::Conflict));
    }
    let turn: String = row.get("turn_id")?;
    let committed_ms: f64 = row.get("committed_ms")?;
    let entry_id: i64 = row.get("id")?;
    Ok(match ChatMessageId::parse(&turn) {
        Ok(turn_id) if committed_ms.is_finite() && committed_ms >= 0.0 && entry_id > 0 => {
            Ok(JournalReceipt::Committed {
                turn_id,
                entry_id,
                committed_ms,
                digest,
            })
        }
        _ => Err(MemoryError::Integrity),
    })
}
