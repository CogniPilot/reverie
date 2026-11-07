use super::*;
use rusqlite::backup::{Backup, StepResult};
use std::time::Instant;

// These new curated snapshot operations must not retain the owner workflow
// indefinitely. SQLite busy handlers are disabled during copying; bounded page
// steps and a fixed deadline also cover continuously changing source databases.
const COPY_BUDGET: Duration = Duration::from_secs(2);
const BUSY_PAUSE: Duration = Duration::from_millis(10);
fn close(connection: Connection) -> Result<()> {
    connection.close().map_err(|(_, error)| error.into())
}
fn integrity(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA integrity_check")?;
    let results = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if results != ["ok"] {
        return Err(MemoryError::Integrity);
    }
    Ok(())
}
fn same_database(connection: &Connection, path: &Path) -> Result<()> {
    let Some(original) = connection.path().filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    let original = Path::new(original);
    let selected = match std::fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let opened = std::fs::metadata(original)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (opened.dev(), opened.ino()) == (selected.dev(), selected.ino()) {
            return Err(MemoryError::SameDatabase);
        }
    }
    // Also checks spelling/symlink aliases on platforms without Unix inode
    // metadata. The bounded copy remains necessary if names change afterward.
    if std::fs::canonicalize(original)? == std::fs::canonicalize(path)? {
        return Err(MemoryError::SameDatabase);
    }
    Ok(())
}
fn copy(from: &Connection, to: &mut Connection) -> Result<()> {
    to.busy_timeout(Duration::ZERO)?;
    let copied = copy_pages(from, to);
    finalized(
        copied,
        to.busy_timeout(Duration::from_secs(30)).map_err(Into::into),
    )
}
fn copy_pages(from: &Connection, to: &mut Connection) -> Result<()> {
    let backup = Backup::new(from, to)?;
    let deadline = Instant::now() + COPY_BUDGET;
    loop {
        if Instant::now() >= deadline {
            return Err(MemoryError::SnapshotTimeout);
        }
        match backup.step(64)? {
            StepResult::Done => return Ok(()),
            StepResult::Busy | StepResult::Locked => std::thread::sleep(BUSY_PAUSE),
            StepResult::More => {}
            _ => return Err(MemoryError::Integrity),
        }
    }
}
pub(super) fn backup_to(from: &Connection, path: &Path) -> Result<()> {
    durable_snapshot_path(path)?;
    let path = sqlite_path(path)?;
    if !from.is_autocommit() {
        return Err(MemoryError::ActiveTransaction);
    }
    same_database(from, &path)?;
    let mut destination = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let result = same_database(from, &path)
        .and_then(|()| copy(from, &mut destination))
        .and_then(|()| integrity(&destination));
    finalized(result, close(destination))
        .map_err(|error| MemoryError::BackupUncertain(Box::new(error)))
}
pub(super) fn restore_from(destination: &mut Connection, path: &Path) -> Result<()> {
    durable_snapshot_path(path)?;
    let path = sqlite_path(path)?;
    same_database(destination, &path)?;
    let source = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // Empty SQLite filename means its private auto-deleted temporary database,
    // avoiding an in-RAM copy or a caller-selected intermediate editor path.
    let mut staged = match Connection::open_with_flags(
        "",
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(value) => value,
        Err(error) => return finalized(Err(error.into()), close(source)),
    };
    let prepared = (|| {
        configure_connection(&staged)?;
        source.busy_timeout(Duration::ZERO)?;
        same_database(destination, &path)?;
        integrity(&source)?;
        copy(&source, &mut staged)?;
        staged.execute_batch(SCHEMA)?;
        migrate(&mut staged)?;
        integrity(&staged)
    })();
    let prepared = finalized(prepared, close(source));
    if let Err(error) = prepared {
        return finalized(Err(error), close(staged));
    }
    // A failed copy or finalizer after this point never claims that the old
    // destination remains installed. Keep the selected snapshot for recovery.
    let result = copy(&staged, destination).and_then(|()| integrity(destination));
    finalized(result, close(staged)).map_err(|error| MemoryError::RestoreUncertain(Box::new(error)))
}
fn durable_snapshot_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || is_memory_name(path) {
        return Err(MemoryError::EphemeralSnapshot);
    }
    Ok(())
}
