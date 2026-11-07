//! One closed native metadata namespace. Historical generic state is never
//! adopted, rewritten or interpreted as evidence of this owner.
use super::*;
use rusqlite::{OptionalExtension, params};

const NAME: &str = "reverie_native_memory_v1";
const SQL: &str = "CREATE TABLE reverie_native_memory_v1(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL,phase TEXT NOT NULL,model TEXT)";
const OLD_KEYS: [&str; 2] = ["native_memory_startup_v1", "native_memory_embed_model_v1"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum Observed {
    Legacy,
    Native(MemoryReadiness),
}
pub(super) fn observe(db: &Connection) -> Result<Observed> {
    let mut statement = db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE name=?1 COLLATE NOCASE OR tbl_name=?1 COLLATE NOCASE")?;
    let objects = statement
        .query_map([NAME], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if objects.is_empty() {
        refuse_old_markers(db)?;
        return Ok(Observed::Legacy);
    }
    if objects
        != [(
            "table".to_owned(),
            NAME.to_owned(),
            NAME.to_owned(),
            Some(SQL.to_owned()),
        )]
    {
        return Err(MemoryError::ForeignReadinessNamespace);
    }
    let mut statement =
        db.prepare("SELECT singleton,format,phase,model FROM main.reverie_native_memory_v1")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| MemoryError::MalformedReadinessMetadata)?;
    let [(singleton, format, phase, model)] = rows.as_slice() else {
        return Err(MemoryError::MalformedReadinessMetadata);
    };
    if *singleton != 1 {
        return Err(MemoryError::MalformedReadinessMetadata);
    }
    if *format != 1 {
        return Err(MemoryError::UnsupportedReadinessVersion);
    }
    let phase =
        MemoryStartupPhase::parse(phase).map_err(|_| MemoryError::MalformedReadinessMetadata)?;
    let state = MemoryReadiness::try_new(phase, model.clone())
        .map_err(|_| MemoryError::MalformedReadinessMetadata)?;
    Ok(Observed::Native(state))
}
fn refuse_old_markers(db: &Connection) -> Result<()> {
    let state = db
        .query_row(
            "SELECT 1 FROM main.sqlite_schema WHERE name='state' COLLATE NOCASE",
            [],
            |_| Ok(()),
        )
        .optional()?;
    if state.is_some()
        && db
            .query_row(
                "SELECT 1 FROM main.state WHERE key COLLATE BINARY IN (?1,?2) LIMIT 1",
                OLD_KEYS,
                |_| Ok(()),
            )
            .optional()?
            .is_some()
    {
        return Err(MemoryError::LegacyReadinessCollision);
    }
    Ok(())
}
pub(super) fn initializing(db: &Connection, previous: &Observed) -> Result<MemoryReadiness> {
    match previous {
        Observed::Legacy => {
            db.execute_batch(SQL)?;
            db.execute(
                "INSERT INTO main.reverie_native_memory_v1 VALUES(1,1,'initializing',NULL)",
                [],
            )?;
        }
        Observed::Native(_) => {
            db.execute("UPDATE main.reverie_native_memory_v1 SET phase='initializing',model=NULL WHERE singleton=1 AND format=1", [])?;
        }
    }
    MemoryReadiness::try_new(MemoryStartupPhase::Initializing, None)
        .map_err(|_| MemoryError::MalformedReadinessMetadata)
}
pub(super) fn publish(
    db: &Connection,
    expected: &MemoryReadiness,
    next: &MemoryReadiness,
) -> Result<()> {
    if observe(db)? != Observed::Native(expected.clone()) {
        return Err(MemoryError::ReadinessChanged);
    }
    if db.execute(
        "UPDATE main.reverie_native_memory_v1 SET phase=?1,model=?2 WHERE singleton=1 AND format=1",
        params![next.phase().as_str(), next.model()],
    )? != 1
    {
        return Err(MemoryError::ReadinessChanged);
    }
    Ok(())
}
