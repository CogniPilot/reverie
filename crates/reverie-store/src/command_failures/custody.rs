use super::{
    FailureLog,
    error::{FailureStoreError, Result, finalized, need},
};
use crate::private_fs::{self, CloseRole};
use rusqlite::{Connection, OpenFlags};
use std::{
    fs::{self, File},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::Path,
    time::Duration,
};
const LEAF: &str = "command-failures.sqlite";
#[derive(Clone, Copy)]
pub(super) struct Identity {
    dev: u64,
    ino: u64,
}
impl Identity {
    pub(super) fn of(info: &fs::Metadata) -> Self {
        Self {
            dev: info.dev(),
            ino: info.ino(),
        }
    }
    fn matches(self, info: &fs::Metadata) -> bool {
        self.dev == info.dev() && self.ino == info.ino()
    }
}
fn parent(path: &Path) -> Result<File> {
    Ok(private_fs::open_at(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )?)
}
fn file(parent: &File, create: bool) -> Result<File> {
    Ok(private_fs::open_at(
        parent.as_raw_fd(),
        std::ffi::OsStr::new(LEAF),
        libc::O_RDWR | libc::O_NONBLOCK | if create { libc::O_CREAT } else { 0 },
        0o600,
    )?)
}
fn directory_private(info: &fs::Metadata, uid: u32) -> bool {
    info.is_dir() && info.uid() == uid && info.mode() & 0o077 == 0
}
fn file_private(info: &fs::Metadata, uid: u32) -> bool {
    info.is_file() && info.uid() == uid && info.nlink() == 1 && info.mode() & 0o077 == 0
}
fn close(file: File, path: &Path) -> Result<()> {
    Ok(private_fs::close(file, CloseRole::Data, path)?)
}
/// The purpose's caller has already checked/created its employee parent. Only
/// fixed hands is created here; no generic ancestor creation or source fallback.
pub(super) fn capture(
    directory: &Path,
    uid: u32,
    purpose: super::OpenPurpose,
) -> Result<(Identity, Identity)> {
    crate::storage_identity::canonical(directory)?;
    if matches!(purpose, super::OpenPurpose::CreateHands) {
        match std::fs::DirBuilder::new().mode(0o700).create(directory) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    let info = fs::symlink_metadata(directory)?;
    need(directory_private(&info, uid))?;
    let held = parent(directory)?;
    let mut opened = None;
    let result = (|| {
        let current = held.metadata()?;
        need(Identity::of(&info).matches(&current))?;
        opened = Some(file(
            &held,
            matches!(purpose, super::OpenPurpose::CreateHands),
        )?);
        let st = opened.as_ref().expect("owned file").metadata()?;
        need(file_private(&st, uid))?;
        Ok((Identity::of(&current), Identity::of(&st)))
    })();
    let result = finalized(
        result,
        opened.map_or(Ok(()), |file| close(file, &directory.join(LEAF))),
    );
    finalized(result, close(held, directory))
}
use std::os::unix::fs::DirBuilderExt;
struct Opened {
    parent: Option<File>,
    file: Option<File>,
    actual: Option<File>,
    db: Option<Connection>,
}
impl Opened {
    fn prepare(&mut self, log: &FailureLog) -> Result<()> {
        self.parent = Some(parent(&log.directory)?);
        let parent = self.parent.as_ref().expect("owned parent");
        need(
            log.directory_id.matches(&parent.metadata()?)
                && directory_private(&parent.metadata()?, log.uid),
        )?;
        self.file = Some(file(parent, false)?);
        let file = self.file.as_ref().expect("owned database file");
        log.check_file(&file.metadata()?)?;
        self.db = Some(Connection::open_with_flags(
            format!("file:/proc/self/fd/{}?mode=rw", file.as_raw_fd()),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?);
        let db = self.db.as_ref().expect("owned connection");
        db.busy_timeout(Duration::from_millis(50))?;
        let named = fs::symlink_metadata(&log.directory)?;
        need(log.directory_id.matches(&named) && directory_private(&named, log.uid))?;
        log.check_file(&fs::symlink_metadata(log.directory.join(LEAF))?)?;
        let (label, path): (String, String) = db.query_row("PRAGMA database_list", [], |row| {
            Ok((row.get(1)?, row.get(2)?))
        })?;
        need(label == "main")?;
        self.actual = Some(private_fs::open_at(
            libc::AT_FDCWD,
            std::ffi::OsStr::new(&path),
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        )?);
        log.check_file(
            &self
                .actual
                .as_ref()
                .expect("owned SQLite actual name")
                .metadata()?,
        )?;
        db.execute_batch(
            "PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;",
        )?;
        let pages = reverie_core::command_telemetry::FAILURE_PAGES;
        let maximum: i64 = db.query_row(&format!("PRAGMA max_page_count={pages}"), [], |row| {
            row.get(0)
        })?;
        need(maximum <= i64::from(pages))
    }
    fn finish<T>(mut self, result: Result<T>, directory: &Path) -> Result<T> {
        // Source ExitStack: resolved-name FD, SQLite, data FD, directory FD.
        // Attempt all finalizers after either an operation or close failure.
        let result = finalized(
            result,
            self.actual.take().map_or(Ok(()), |f| close(f, directory)),
        );
        let closed = self.db.take().map_or(Ok(()), |db| {
            #[cfg(test)]
            super::tests::before_close(&db);
            db.close().map_err(|(db, cause)| {
                FailureStoreError::Close(super::error::RetainedConnection::new(db, cause))
            })
        });
        let result = finalized(result, closed);
        let result = finalized(
            result,
            self.file
                .take()
                .map_or(Ok(()), |f| close(f, &directory.join(LEAF))),
        );
        finalized(
            result,
            self.parent.take().map_or(Ok(()), |f| close(f, directory)),
        )
    }
}
impl FailureLog {
    fn check_file(&self, info: &fs::Metadata) -> Result<()> {
        need(self.file_id.matches(info) && file_private(info, self.uid))
    }
    pub(super) fn with_database<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let mut opened = Opened {
            parent: None,
            file: None,
            actual: None,
            db: None,
        };
        let result = opened
            .prepare(self)
            .and_then(|()| operation(opened.db.as_ref().expect("prepared connection")));
        opened.finish(result, &self.directory)
    }
}
