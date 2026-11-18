use super::contract::{
    Advance, Binding, Dimension, Reason, Reserve, State, canonical, digest, stored,
};
use super::journal::{
    MAX_ACTIVE, MAX_BODY, Table, append, blocked_until, existing_budget, restart_hash,
    transition_hash,
};
use super::receipt::{Attempt, Budget, Reply, Single, id};
use super::validate::History;
use super::{Error, Result, require};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn reserve(db: &Connection, history: &History, input: Reserve) -> Result<Reply> {
    let fingerprint = digest(&input.binding)?;
    if let Some(original) = original_reservation(db, &input, &fingerprint)? {
        return Ok(original);
    }
    if let Some(alert) = quota(db, &input.binding, input.now)? {
        return Ok(alert);
    }
    let mut active = 0;
    for latest in history
        .latest
        .values()
        .filter(|item| item.state.unresolved())
    {
        require(
            !latest.binding.overlaps(&input.binding),
            Error::UnresolvedAttempt,
        )?;
        active += 1;
    }
    require(active < MAX_ACTIVE, Error::QueueFull)?;
    Table::Attempts.room(db)?;
    let receipt = Attempt::queued(id()?, input.binding, input.now)?;
    db.execute(
        "INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?)",
        params![
            receipt.attempt_id,
            receipt.binding.employee_id,
            receipt.binding.goal_id,
            receipt.binding.session_id,
            input.now,
            canonical(&receipt.binding)?,
            input.key,
            fingerprint,
        ],
    )?;
    append(db, &receipt, "@reserve", &fingerprint)?;
    Ok(Reply::Attempt(Single {
        replayed: false,
        receipt,
    }))
}

fn original_reservation(
    db: &Connection,
    input: &Reserve,
    fingerprint: &str,
) -> Result<Option<Reply>> {
    let existing: Option<(String, String)> = db
        .query_row(
            "SELECT id,fingerprint FROM attempts WHERE employee=? AND key=?",
            params![input.binding.employee_id, input.key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((attempt, prior)) = existing else {
        return Ok(None);
    };
    require(prior == fingerprint, Error::IdempotencyConflict)?;
    let raw: String = db.query_row(
        "SELECT body FROM events WHERE attempt=? AND sequence=1",
        [attempt],
        |row| row.get(0),
    )?;
    Ok(Some(Reply::Attempt(Single {
        replayed: true,
        receipt: stored(&raw, MAX_BODY)?,
    })))
}

fn quota(db: &Connection, binding: &Binding, now: i64) -> Result<Option<Reply>> {
    for dimension in Dimension::ALL {
        let subject = binding.subject(dimension);
        if let Some(until) = blocked_until(db, dimension, subject, now)? {
            return Ok(Some(report_budget(db, dimension, subject, until, now)?));
        }
    }
    Ok(None)
}

fn report_budget(
    db: &Connection,
    dimension: Dimension,
    subject: &str,
    until: i64,
    now: i64,
) -> Result<Reply> {
    if let Some(receipt) = existing_budget(db, dimension, subject, until)? {
        return Ok(Reply::Budget(Single {
            replayed: true,
            receipt,
        }));
    }
    Table::Alerts.room(db)?;
    let receipt = Budget::new(dimension, subject, until, now)?;
    db.execute(
        "INSERT INTO alerts VALUES(?,?,?,?,?)",
        params![
            receipt.receipt_id,
            dimension.column(),
            subject,
            until,
            canonical(&receipt)?
        ],
    )?;
    Ok(Reply::Budget(Single {
        replayed: false,
        receipt,
    }))
}

pub(super) fn advance(db: &Connection, history: &History, input: Advance) -> Result<Reply> {
    let latest = history
        .latest
        .get(&input.attempt)
        .ok_or(Error::BindingChanged)?;
    require(latest.binding == input.binding, Error::BindingChanged)?;
    let key = format!("transition:{}", input.key);
    let fingerprint = transition_hash(
        &input.binding,
        &input.attempt,
        input.sequence,
        input.expected,
        input.state,
        input.reason,
    )?;
    if let Some(original) = original_transition(db, &input.attempt, &key, &fingerprint)? {
        return Ok(original);
    }
    require(
        latest.sequence == input.sequence && latest.state == input.expected,
        Error::CasStale,
    )?;
    let receipt = latest.advance(input.state, input.reason, input.now)?;
    append(db, &receipt, &key, &fingerprint)?;
    Ok(Reply::Attempt(Single {
        replayed: false,
        receipt,
    }))
}

fn original_transition(
    db: &Connection,
    attempt: &str,
    key: &str,
    fingerprint: &str,
) -> Result<Option<Reply>> {
    let existing: Option<(String, String)> = db
        .query_row(
            "SELECT fingerprint,body FROM events WHERE attempt=? AND key=?",
            [attempt, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((prior, raw)) = existing else {
        return Ok(None);
    };
    require(prior == fingerprint, Error::IdempotencyConflict)?;
    Ok(Some(Reply::Attempt(Single {
        replayed: true,
        receipt: stored(&raw, MAX_BODY)?,
    })))
}

pub(super) fn restart(db: &Connection, history: &History, now: i64) -> Result<Reply> {
    let mut statement = db.prepare(
        "SELECT a.id,a.binding,e.sequence,e.state FROM attempts a JOIN events e ON e.attempt=a.id
         WHERE e.sequence=(SELECT MAX(x.sequence) FROM events x WHERE x.attempt=a.id)
         AND e.state IN ('QUEUED','SUBMITTED','TURN_STARTED')",
    )?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    require(ids.len() <= MAX_ACTIVE, Error::QueueFull)?;
    let mut receipts = Vec::with_capacity(ids.len());
    for id in ids {
        let prior = history.latest.get(&id).ok_or(Error::StoreUnavailable)?;
        let receipt = prior.advance(State::Uncertain, Reason::ProcessRestart, now)?;
        append(db, &receipt, "@restart", &restart_hash(prior)?)?;
        receipts.push(receipt);
    }
    Ok(Reply::Restart(receipts))
}
