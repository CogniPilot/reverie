use super::{Error, Result, require};
use crate::error::StoreError;
use crate::private_fs::{CloseRole, Directory, Stamp, close};
use rusqlite::{Connection, OpenFlags};
use std::{io, path::Path, time::Duration};

pub(super) struct Custody {
    directory: Directory,
    leaf: String,
    identity: Stamp,
}

impl Custody {
    pub(super) fn open(path: &Path) -> Result<(Self, Connection)> {
        require(path.is_absolute(), Error::CustodyInvalid)?;
        let leaf = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(Error::CustodyInvalid)?;
        let parent = path.parent().ok_or(Error::CustodyInvalid)?;
        let directory = Directory::open(parent).map_err(|_| Error::CustodyInvalid)?;
        let fresh = create(&directory, leaf)?;
        let identity = database_stamp(&directory, leaf)?;
        let custody = Self {
            directory,
            identity,
            leaf: leaf.to_owned(),
        };
        custody.check()?;
        let db = connect(path)?;
        if fresh {
            db.execute_batch(include_str!("schema.sql"))?;
            custody
                .directory
                .sync()
                .map_err(|_| Error::StoreUnavailable)?;
        }
        custody.check()?;
        Ok((custody, db))
    }

    pub(super) fn check(&self) -> Result<()> {
        self.directory.check().map_err(|_| Error::CustodyInvalid)?;
        let named = database_stamp(&self.directory, &self.leaf)?;
        require(named.same_inode(&self.identity), Error::CustodyInvalid)
    }

    pub(super) fn close(self) -> Result<()> {
        self.directory.close().map_err(|_| Error::StoreUnavailable)
    }
}

fn create(directory: &Directory, leaf: &str) -> Result<bool> {
    match directory.create_exclusive(leaf) {
        Ok(file) => {
            close(file, CloseRole::Data, directory.path()).map_err(|_| Error::StoreUnavailable)?;
            Ok(true)
        }
        Err(StoreError::Io { source, .. }) if source.kind() == io::ErrorKind::AlreadyExists => {
            Ok(false)
        }
        Err(_) => Err(Error::StoreUnavailable),
    }
}

fn database_stamp(directory: &Directory, leaf: &str) -> Result<Stamp> {
    directory
        .stamp(leaf)
        .map_err(|_| Error::CustodyInvalid)?
        .filter(Stamp::private_file)
        .ok_or(Error::CustodyInvalid)
}

fn connect(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_millis(250))?;
    db.pragma_update(None, "journal_mode", "DELETE")?;
    db.pragma_update(None, "synchronous", "FULL")?;
    db.pragma_update(None, "max_page_count", 4096)?;
    db.pragma_update(None, "trusted_schema", "OFF")?;
    Ok(db)
}
