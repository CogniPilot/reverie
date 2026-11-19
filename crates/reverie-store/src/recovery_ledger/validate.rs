//! Validate bounded evidence under the current SQLite writer lock.
use super::contract::{
    Binding, Reason, State, canonical, canonical_id, digest, integer, operation_key, receipt_id,
    stored, usable_clock,
};
use super::journal::{MAX_BODY, Table, blocked_until, restart_hash, transition_hash};
use super::receipt::{Attempt, Budget};
use super::{Error, Result, require};
use rusqlite::{Connection, Row};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct History {
    pub(super) floor: i64,
    pub(super) latest: BTreeMap<String, Attempt>,
}

pub(super) fn version(db: &Connection) -> Result<()> {
    let user_version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let mut stmt = db.prepare("SELECT version FROM ledger_meta")?;
    let mut rows = stmt.query([])?;
    let version = rows
        .next()?
        .ok_or(Error::StoreUnavailable)?
        .get::<_, i64>(0)?;
    valid(user_version == 1 && version == 1 && rows.next()?.is_none())
}

pub(super) fn load(db: &Connection) -> Result<History> {
    columns(db)?;
    version(db)?;
    let floor = db.query_row("SELECT clock_floor FROM ledger_meta", [], |row| row.get(0))?;
    valid(usable_clock(floor))?;
    for table in Table::ALL {
        valid(table.count(db)? <= table.limit())?;
    }
    let headers = headers(db, floor)?;
    let mut receipts = BTreeSet::new();
    let latest = events(db, floor, &headers, &mut receipts)?;
    valid(latest.len() == headers.len())?;
    alerts(db, floor, &mut receipts)?;
    Ok(History { floor, latest })
}

fn columns(db: &Connection) -> Result<()> {
    for (table, expected) in [
        ("ledger_meta", &["version", "clock_floor"][..]),
        (
            "attempts",
            &[
                "id",
                "employee",
                "goal",
                "session",
                "issued",
                "binding",
                "key",
                "fingerprint",
            ],
        ),
        (
            "events",
            &[
                "id",
                "attempt",
                "sequence",
                "state",
                "key",
                "fingerprint",
                "body",
            ],
        ),
        (
            "alerts",
            &["id", "dimension", "subject", "blocked_until", "body"],
        ),
    ] {
        let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = statement.query([])?;
        for expected_name in expected {
            let row = rows.next()?.ok_or(Error::StoreUnavailable)?;
            let name: String = row.get(1)?;
            let kind: String = row.get(2)?;
            let expected_kind = match name.as_str() {
                "version" | "clock_floor" | "issued" | "sequence" | "blocked_until" => "INTEGER",
                _ => "TEXT",
            };
            valid(name == *expected_name && kind == expected_kind)?;
        }
        valid(rows.next()?.is_none())?;
    }
    Ok(())
}

fn valid(condition: bool) -> Result<()> {
    require(condition, Error::StoreUnavailable)
}

struct Header {
    binding: Binding,
    issued: i64,
    fingerprint: String,
}

fn headers(db: &Connection, floor: i64) -> Result<BTreeMap<String, Header>> {
    let mut stmt =
        db.prepare("SELECT id,employee,goal,session,issued,binding,key,fingerprint FROM attempts")?;
    let mut rows = stmt.query([])?;
    let mut headers = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        valid(receipt_id(&id))?;
        valid(headers.insert(id, header(row, floor)?).is_none())?;
    }
    Ok(headers)
}

fn header(row: &Row<'_>, floor: i64) -> Result<Header> {
    let raw: String = row.get(5)?;
    let binding: Binding = stored(&raw, 1024)?;
    let issued = row.get(4)?;
    let key: String = row.get(6)?;
    let fingerprint: String = row.get(7)?;
    valid(binding.valid() && integer(issued, 0) && issued <= floor && operation_key(&key))?;
    valid(
        row.get::<_, String>(1)? == binding.employee_id
            && row.get::<_, String>(2)? == binding.goal_id
            && row.get::<_, String>(3)? == binding.session_id
            && raw == canonical(&binding)?
            && fingerprint == digest(&binding)?,
    )?;
    Ok(Header {
        binding,
        issued,
        fingerprint,
    })
}

fn events(
    db: &Connection,
    floor: i64,
    headers: &BTreeMap<String, Header>,
    receipts: &mut BTreeSet<String>,
) -> Result<BTreeMap<String, Attempt>> {
    let mut stmt = db.prepare(
        "SELECT id,attempt,sequence,state,key,fingerprint,body FROM events ORDER BY attempt,sequence",
    )?;
    let mut rows = stmt.query([])?;
    let mut latest = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let item: Attempt = stored(&row.get::<_, String>(6)?, MAX_BODY)?;
        let header = headers
            .get(&item.attempt_id)
            .ok_or(Error::StoreUnavailable)?;
        event_columns(row, floor, &item, header)?;
        let key: String = row.get(4)?;
        let fingerprint: String = row.get(5)?;
        let previous = latest.get(&item.attempt_id);
        valid(fingerprint == event_hash(&item, header, previous, &key)?)?;
        valid(receipts.insert(item.receipt_id.clone()))?;
        latest.insert(item.attempt_id.clone(), item);
    }
    Ok(latest)
}

fn event_columns(row: &Row<'_>, floor: i64, item: &Attempt, header: &Header) -> Result<()> {
    valid(
        item.schema_version == 1
            && item.binding == header.binding
            && receipt_id(&item.receipt_id)
            && integer(item.sequence, 1)
            && integer(item.created_at_ms, 0)
            && item.created_at_ms <= floor
            && item.state.accepts(item.reason)
            && item.receipt_id == row.get::<_, String>(0)?
            && item.attempt_id == row.get::<_, String>(1)?
            && item.sequence == row.get::<_, i64>(2)?
            && item.state.as_str() == row.get::<_, String>(3)?,
    )
}

fn event_hash(
    item: &Attempt,
    header: &Header,
    prior: Option<&Attempt>,
    key: &str,
) -> Result<String> {
    let Some(prior) = prior else {
        valid(
            item.sequence == 1
                && item.state == State::Queued
                && key == "@reserve"
                && item.created_at_ms == header.issued,
        )?;
        return Ok(header.fingerprint.clone());
    };
    valid(
        item.sequence == prior.sequence + 1
            && prior.state.allows(item.state)
            && item.created_at_ms >= prior.created_at_ms,
    )?;
    if key == "@restart" {
        valid(item.state == State::Uncertain && item.reason == Reason::ProcessRestart)?;
        return restart_hash(prior);
    }
    valid(key.strip_prefix("transition:").is_some_and(operation_key))?;
    transition_hash(
        &item.binding,
        &item.attempt_id,
        prior.sequence,
        prior.state,
        item.state,
        item.reason,
    )
}

fn alerts(db: &Connection, floor: i64, receipts: &mut BTreeSet<String>) -> Result<()> {
    let mut stmt = db.prepare("SELECT id,dimension,subject,blocked_until,body FROM alerts")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let item: Budget = stored(&row.get::<_, String>(4)?, MAX_BODY)?;
        valid(
            item.schema_version == 1
                && receipt_id(&item.receipt_id)
                && canonical_id(&item.subject)
                && integer(item.created_at_ms, 0)
                && integer(item.blocked_until_ms, 0)
                && item.created_at_ms <= floor
                && item.receipt_id == row.get::<_, String>(0)?
                && item.dimension.column() == row.get::<_, String>(1)?
                && item.subject == row.get::<_, String>(2)?
                && item.blocked_until_ms == row.get::<_, i64>(3)?
                && receipts.insert(item.receipt_id),
        )?;
        valid(
            blocked_until(db, item.dimension, &item.subject, item.created_at_ms)?
                == Some(item.blocked_until_ms),
        )?;
    }
    Ok(())
}
