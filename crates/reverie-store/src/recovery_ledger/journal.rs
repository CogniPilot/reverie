use super::contract::{Binding, Dimension, Reason, State, canonical, digest, stored};
use super::receipt::{Attempt, Budget};
use super::{Error, Result, WINDOW_MS, require};
use rusqlite::{Connection, OptionalExtension, params};

const MAX_ATTEMPTS: i64 = 3;
pub(super) const MAX_ACTIVE: usize = 128;
pub(super) const MAX_BODY: usize = 2048;

#[derive(Clone, Copy)]
pub(super) enum Table {
    Attempts,
    Events,
    Alerts,
}

impl Table {
    pub(super) const ALL: [Self; 3] = [Self::Attempts, Self::Events, Self::Alerts];

    pub(super) fn limit(self) -> i64 {
        match self {
            Self::Attempts | Self::Alerts => 4096,
            Self::Events => 16384,
        }
    }

    pub(super) fn count(self, db: &Connection) -> Result<i64> {
        let sql = match self {
            Self::Attempts => "SELECT count(*) FROM attempts",
            Self::Events => "SELECT count(*) FROM events",
            Self::Alerts => "SELECT count(*) FROM alerts",
        };
        Ok(db.query_row(sql, [], |row| row.get(0))?)
    }

    pub(super) fn room(self, db: &Connection) -> Result<()> {
        require(self.count(db)? < self.limit(), Error::StoreFull)
    }
}

pub(super) fn append(db: &Connection, item: &Attempt, key: &str, fingerprint: &str) -> Result<()> {
    Table::Events.room(db)?;
    db.execute(
        "INSERT INTO events VALUES(?,?,?,?,?,?,?)",
        params![
            item.receipt_id,
            item.attempt_id,
            item.sequence,
            item.state.as_str(),
            key,
            fingerprint,
            canonical(item)?,
        ],
    )?;
    Ok(())
}

pub(super) fn transition_hash(
    binding: &Binding,
    attempt: &str,
    sequence: i64,
    expected: State,
    state: State,
    reason: Reason,
) -> Result<String> {
    digest(&(binding, attempt, sequence, expected, state, reason))
}

pub(super) fn restart_hash(prior: &Attempt) -> Result<String> {
    digest(&(
        &prior.attempt_id,
        prior.sequence,
        prior.state,
        Reason::ProcessRestart,
    ))
}

pub(super) fn blocked_until(
    db: &Connection,
    dimension: Dimension,
    subject: &str,
    now: i64,
) -> Result<Option<i64>> {
    let column = dimension.column();
    let query = format!(
        "SELECT issued FROM attempts WHERE {column}=?1 AND issued>?2 AND issued<=?3
         ORDER BY issued DESC LIMIT 1 OFFSET ?4"
    );
    let issued: Option<i64> = db
        .query_row(
            &query,
            params![subject, now - WINDOW_MS, now, MAX_ATTEMPTS - 1],
            |row| row.get(0),
        )
        .optional()?;
    Ok(issued.map(|ms| ms + WINDOW_MS))
}

pub(super) fn existing_budget(
    db: &Connection,
    dimension: Dimension,
    subject: &str,
    until: i64,
) -> Result<Option<Budget>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT body FROM alerts WHERE dimension=? AND subject=? AND blocked_until=?",
            params![dimension.column(), subject, until],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| stored(&raw, MAX_BODY)).transpose()
}
