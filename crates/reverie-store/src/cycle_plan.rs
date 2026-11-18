//! Publish normalized model-plan telemetry inside the existing cycle ledger.
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use std::{path::Path, time::Duration};

const RETENTION_SECONDS: f64 = 30.0 * 86_400.0;

pub struct Sample {
    pub profile: String,
    pub body: String,
}

/// All readings and expiry changes belong to one transaction. The cycle
/// scheduler already created this ledger before requesting a refresh.
pub fn record(path: &Path, now: f64, samples: &[Sample]) -> rusqlite::Result<()> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut connection = Connection::open_with_flags(path, flags)?;
    connection.busy_timeout(Duration::from_secs(30))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "CREATE TABLE IF NOT EXISTS plan_samples (profile TEXT, sampled_at REAL, body TEXT)",
        [],
    )?;
    {
        let mut insert = transaction.prepare("INSERT INTO plan_samples VALUES (?,?,?)")?;
        for sample in samples {
            insert.execute(params![sample.profile, now, sample.body])?;
        }
    }
    transaction.execute(
        "DELETE FROM plan_samples WHERE sampled_at < ?",
        [now - RETENTION_SECONDS],
    )?;
    transaction.commit()
}
