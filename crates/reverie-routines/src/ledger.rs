//! The host ledger: the same SQLite file and schema python's tick kept. Every send is recorded BEFORE it is attempted.
//! A row that cannot be written means no send, and a corrupt file is an error, so the tick fails closed instead of
//! re-sending.

use crate::json::{Json, py_float};
use rusqlite::{Connection, ErrorCode, OptionalExtension, params, params_from_iter};
use std::path::Path;
use std::time::Duration;

const SCHEMA: &str = "
create table if not exists sends(kind text not null, agent text not null, slot text not null, day text not null,
    ts real not null, status text not null, primary key(kind, agent, slot));
create table if not exists obs(agent text primary key, down_since real, down_last real, down_count integer not null default 0,
    down_reported integer not null default 0, dialog_since real);
create table if not exists meta(key text primary key, value text);
";

/// Statuses that count against caps. A failed attempt counts too, so failures never become a retry flood.
const COUNTED: [&str; 4] = ["pending", "sent", "failed", "dry"];

pub type Result<T> = std::result::Result<T, rusqlite::Error>;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Obs {
    pub down_since: Option<f64>,
    pub down_last: Option<f64>,
    pub down_count: i64,
    pub down_reported: i64,
    pub dialog_since: Option<f64>,
}

pub struct Ledger {
    db: Connection,
}

/// Why the ledger could not be opened: the directory (python's OSError) or the database (sqlite3.Error).
#[derive(Debug)]
pub enum OpenError {
    Dir(String),
    Db(rusqlite::Error),
}

impl Ledger {
    pub fn open(path: &Path) -> std::result::Result<Ledger, OpenError> {
        if let Some(parent) = path.parent() {
            create_dir_0700(parent).map_err(|e| OpenError::Dir(crate::py_os_error(&e, parent)))?;
        }
        let db = Connection::open(path).map_err(OpenError::Db)?;
        db.busy_timeout(Duration::from_secs(30))
            .map_err(OpenError::Db)?;
        let init = |db: &Connection| -> Result<()> {
            db.query_row("pragma journal_mode=wal", [], |_| Ok(()))?;
            db.execute_batch(SCHEMA)?;
            let check: String = db.query_row("pragma quick_check", [], |r| r.get(0))?;
            if check != "ok" {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                    Some("state file failed its check".into()),
                ));
            }
            Ok(())
        };
        init(&db).map_err(OpenError::Db)?;
        Ok(Ledger { db })
    }

    /// Record a send for (kind, agent, slot). False when that slot was already used. A 'deferred' row (a re-check
    /// failed before anything was sent) may be claimed again on a later tick.
    pub fn claim(
        &self,
        kind: &str,
        agent: &str,
        slot: &str,
        day: &str,
        now: f64,
        status: &str,
    ) -> Result<bool> {
        let updated = self.db.execute(
            "update sends set status=?, ts=?, day=? where kind=? and agent=? and slot=? and status='deferred'",
            params![status, now, day, kind, agent, slot],
        )?;
        if updated > 0 {
            return Ok(true);
        }
        match self.db.execute(
            "insert into sends values(?,?,?,?,?,?)",
            params![kind, agent, slot, day, now, status],
        ) {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == ErrorCode::ConstraintViolation =>
            {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }

    pub fn finish(&self, kind: &str, agent: &str, slot: &str, status: &str) -> Result<()> {
        self.db.execute(
            "update sends set status=? where kind=? and agent=? and slot=?",
            params![status, kind, agent, slot],
        )?;
        Ok(())
    }

    pub fn count(&self, kinds: &[&str], agent: &str, day: &str) -> Result<i64> {
        let marks = vec!["?"; kinds.len()].join(",");
        let sql = format!(
            "select count(*) from sends where kind in ({marks}) and agent=? and day=? and status in (?,?,?,?)"
        );
        let values: Vec<&str> = kinds
            .iter()
            .copied()
            .chain([agent, day])
            .chain(COUNTED)
            .collect();
        self.db
            .query_row(&sql, params_from_iter(values), |r| r.get(0))
    }

    /// A slot is used unless its only row is 'deferred'.
    pub fn has(&self, kind: &str, agent: &str, slot: &str) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "select 1 from sends where kind=? and agent=? and slot=? and status!='deferred'",
                params![kind, agent, slot],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn obs(&self, agent: &str) -> Result<Obs> {
        Ok(self
            .db
            .query_row(
                "select down_since, down_last, down_count, down_reported, dialog_since from obs where agent=?",
                params![agent],
                |r| {
                    Ok(Obs {
                        down_since: r.get(0)?,
                        down_last: r.get(1)?,
                        down_count: r.get(2)?,
                        down_reported: r.get(3)?,
                        dialog_since: r.get(4)?,
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }

    pub fn set_obs(&self, agent: &str, obs: Obs) -> Result<()> {
        self.db.execute(
            "insert or replace into obs values(?,?,?,?,?,?)",
            params![
                agent,
                obs.down_since,
                obs.down_last,
                obs.down_count,
                obs.down_reported,
                obs.dialog_since
            ],
        )?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        self.db
            .query_row("select value from meta where key=?", params![key], |r| {
                r.get(0)
            })
            .optional()
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db.execute(
            "insert or replace into meta values(?,?)",
            params![key, value],
        )?;
        Ok(())
    }

    /// Today's sends as `[kind, agent, slot, status]` rows, in table order.
    pub fn sends_on(&self, day: &str) -> Result<Vec<Json>> {
        let mut statement = self
            .db
            .prepare("select kind, agent, slot, status from sends where day=?")?;
        let rows = statement.query_map(params![day], |r| {
            Ok(Json::List(vec![
                Json::Str(r.get(0)?),
                Json::Str(r.get(1)?),
                Json::Str(r.get(2)?),
                Json::Str(r.get(3)?),
            ]))
        })?;
        rows.collect()
    }
}

/// An obs row as python's status printed it.
pub fn obs_json(obs: Obs) -> Json {
    let real = |v: Option<f64>| v.map_or(Json::Null, Json::Float);
    Json::Obj(vec![
        ("down_since".into(), real(obs.down_since)),
        ("down_last".into(), real(obs.down_last)),
        ("down_count".into(), Json::Int(i128::from(obs.down_count))),
        (
            "down_reported".into(),
            Json::Int(i128::from(obs.down_reported)),
        ),
        ("dialog_since".into(), real(obs.dialog_since)),
    ])
}

/// `str(float)`, as python stored timestamps in the meta table.
pub fn meta_float(x: f64) -> String {
    py_float(x)
}

/// `Path.mkdir(parents=True, exist_ok=True, mode=0o700)`.
fn create_dir_0700(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
    {
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && dir.is_dir() => Ok(()),
        other => other,
    }
}
