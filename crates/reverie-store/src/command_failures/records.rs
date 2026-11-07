use super::{
    FailureLog,
    error::{Result, need},
};
use reverie_core::command_telemetry::{
    FAILURE_COUNTER_MAX, FAILURE_ENTRIES, FAILURE_RETENTION_SECONDS, FailureCount, FailureEvent,
    FailureExit, FailureReport, FailureTool,
};
use rusqlite::{Connection, OptionalExtension, types::ValueRef};
use std::sync::atomic::Ordering;
fn cutoff(now: u64) -> i64 {
    i64::try_from(now).expect("checked clock")
        - i64::try_from(FAILURE_RETENTION_SECONDS).expect("fixed retention")
}
fn expire(db: &Connection, now: u64) -> Result<i64> {
    let cutoff = cutoff(now);
    let count: i64 = db.query_row("SELECT count(*) FROM failures WHERE t<?", [cutoff], |row| {
        row.get(0)
    })?;
    db.execute("DELETE FROM failures WHERE t<?", [cutoff])?;
    db.execute("UPDATE counters SET n=n+? WHERE name='expired'", [count])?;
    Ok(cutoff)
}
impl FailureLog {
    pub(super) fn insert(&self, db: &Connection, event: &FailureEvent, now: u64) -> Result<bool> {
        expire(db, now)?;
        let old = db
            .query_row(
                "SELECT employee,harness,tool,exit,category FROM failures WHERE execution=?",
                [event.execution().as_str()],
                |row| {
                    Ok((
                        row.get::<_, rusqlite::types::Value>(0)?,
                        row.get::<_, rusqlite::types::Value>(1)?,
                        row.get::<_, rusqlite::types::Value>(2)?,
                        row.get::<_, rusqlite::types::Value>(3)?,
                        row.get::<_, rusqlite::types::Value>(4)?,
                    ))
                },
            )
            .optional()?;
        if let Some((employee, harness, tool, exit, category)) = old {
            use rusqlite::types::Value;
            return Ok(employee == Value::Text(self.employee.as_str().to_owned())
                && harness == Value::Text("hands".to_owned())
                && tool == Value::Text(event.tool().as_str().to_owned())
                && match exit {
                    Value::Integer(value) => value == i64::from(event.exit().get()),
                    Value::Real(value) => value == f64::from(event.exit().get()),
                    _ => false,
                }
                && category == Value::Text(event.exit().category().to_owned()));
        }
        let size: i64 = db.query_row("SELECT count(*) FROM failures", [], |row| row.get(0))?;
        let remove = (size - i64::from(FAILURE_ENTRIES) + 1).max(0);
        if remove > 0 {
            db.execute("DELETE FROM failures WHERE execution IN (SELECT execution FROM failures ORDER BY t,execution LIMIT ?)",[remove])?;
            db.execute("UPDATE counters SET n=n+? WHERE name='evicted'", [remove])?;
        }
        db.execute(
            "INSERT INTO failures VALUES (?,?,?,?,?,?,?)",
            rusqlite::params![
                event.execution().as_str(),
                i64::try_from(now).expect("checked clock"),
                self.employee.as_str(),
                "hands",
                event.tool().as_str(),
                event.exit().get(),
                event.exit().category()
            ],
        )?;
        Ok(true)
    }
    pub(super) fn read_report(&self, db: &Connection, now: u64) -> Result<FailureReport> {
        let cutoff = expire(db, now)?;
        let mut statement=db.prepare("SELECT tool,category,exit,count(*) FROM failures WHERE t>=? AND employee=? AND harness=? GROUP BY tool,category,exit ORDER BY tool,category,exit LIMIT ?")?;
        let mut rows = statement.query(rusqlite::params![
            cutoff,
            self.employee.as_str(),
            "hands",
            FAILURE_ENTRIES
        ])?;
        let mut counts = Vec::new();
        while let Some(row) = rows.next()? {
            if let Some(count) = read_count(row, &self.keys)? {
                counts.push(count)
            }
        }
        let (evicted, expired) = counters(db)?;
        Ok(FailureReport::new(
            self.employee.clone(),
            counts,
            evicted,
            expired,
            self.dropped.load(Ordering::Relaxed),
        ))
    }
}
fn read_count(
    row: &rusqlite::Row<'_>,
    keys: &[reverie_core::worker_options::TelemetryKey],
) -> Result<Option<FailureCount>> {
    for index in 0..4 {
        if let ValueRef::Text(raw) = row.get_ref(index)? {
            need(std::str::from_utf8(raw).is_ok())?;
        }
    }
    let (
        ValueRef::Text(tool),
        ValueRef::Text(category),
        ValueRef::Integer(exit),
        ValueRef::Integer(count),
    ) = (
        row.get_ref(0)?,
        row.get_ref(1)?,
        row.get_ref(2)?,
        row.get_ref(3)?,
    )
    else {
        return Ok(None);
    };
    let Some(tool) = std::str::from_utf8(tool)
        .ok()
        .and_then(FailureTool::parse)
        .filter(|tool| tool.selected(keys))
    else {
        return Ok(None);
    };
    let Some(exit) = i16::try_from(exit).ok().and_then(FailureExit::try_new) else {
        return Ok(None);
    };
    if category != exit.category().as_bytes() || count < 1 {
        return Ok(None);
    }
    let count =
        u32::try_from(count.min(i64::from(FAILURE_ENTRIES))).expect("bounded positive count");
    Ok(FailureCount::try_new(tool, exit, count))
}
fn counter_value(value: rusqlite::types::Value) -> u32 {
    match value {
        rusqlite::types::Value::Integer(n) if n >= 0 => {
            u32::try_from(n.min(i64::from(FAILURE_COUNTER_MAX))).expect("clamped counter")
        }
        _ => 0,
    }
}
fn counters(db: &Connection) -> Result<(u32, u32)> {
    let mut statement =
        db.prepare("SELECT name,n FROM counters WHERE name IN ('evicted','expired')")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, rusqlite::types::Value>(0)?,
            row.get::<_, rusqlite::types::Value>(1)?,
        ))
    })?;
    let (mut evicted, mut expired) = (0, 0);
    for row in rows {
        let (name, value) = row?;
        // Python dict fetches/decodes ALL rows, retains last values and then
        // looks up exact string keys independently of SQL column collation.
        if let rusqlite::types::Value::Text(name) = name {
            match name.as_str() {
                "evicted" => evicted = counter_value(value),
                "expired" => expired = counter_value(value),
                _ => {}
            }
        }
    }
    Ok((evicted, expired))
}
