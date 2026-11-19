//! Exclusive, checked publications in the offline maintenance journal.
use super::Result;
use crate::{native, worker_storage::fs::Directory};
use reverie_core::ids::OfflineStoreOperationId;
use std::{
    ffi::{OsStr, OsString},
    io::{self, Read},
    os::unix::fs::MetadataExt,
    path::Path,
};

pub struct Journal {
    directory: Directory,
    operation: OfflineStoreOperationId,
    uid: u32,
    prepared: Record,
}

struct Record {
    name: OsString,
    identity: (u64, u64),
    bytes: Vec<u8>,
}

impl Journal {
    pub fn prepare(
        path: &Path,
        uid: u32,
        operation: OfflineStoreOperationId,
        bytes: Vec<u8>,
    ) -> Result<Self> {
        let directory = Directory::ensure(path, uid, &mut false)?;
        if directory.mode()? != 0o700 {
            return Err("private audit directory required".into());
        }
        let name = OsString::from(format!("{}.json", operation.as_str()));
        let identity = publish(&directory, &name, uid, &bytes)?;
        let prepared = Record {
            name,
            identity,
            bytes,
        };
        Ok(Self {
            directory,
            operation,
            uid,
            prepared,
        })
    }

    pub fn check(&self) -> Result<()> {
        let record = &self.prepared;
        if confirm(&self.directory, &record.name, self.uid, &record.bytes)? != record.identity {
            return Err("prepared maintenance record changed".into());
        }
        Ok(())
    }

    pub fn receipt(&self, bytes: &[u8]) -> Result<()> {
        let name = format!("{}.prepared-store.json", self.operation.as_str());
        publish(&self.directory, OsStr::new(&name), self.uid, bytes).map(|_| ())
    }

    pub fn close(self) -> Result<()> {
        let current = self.check();
        let closed = self.directory.close().map_err(Into::into);
        current.and(closed)
    }
}

pub struct Fence {
    directory: Directory,
    name: OsString,
    uid: u32,
    identity: (u64, u64),
    bytes: Vec<u8>,
}

impl Fence {
    pub fn publish(path: &Path, uid: u32, bytes: Vec<u8>) -> Result<Self> {
        let directory = Directory::open(path.parent().ok_or("fence directory required")?, uid)?;
        let name = path
            .file_name()
            .ok_or("fence filename required")?
            .to_owned();
        let identity = directory.publish_with_identity(&name, &bytes, &mut false)?;
        let fence = Self {
            directory,
            name,
            uid,
            identity,
            bytes,
        };
        fence.check()?;
        Ok(fence)
    }

    pub fn check(&self) -> Result<()> {
        if confirm(&self.directory, &self.name, self.uid, &self.bytes)? != self.identity {
            return Err("own maintenance fence changed".into());
        }
        Ok(())
    }

    pub fn complete(self, recovery: &[u8]) -> Result<()> {
        self.check()?;
        if let Err(error) = self.directory.unlink(&self.name) {
            // Exclusive creation preserves a replacement fence, if present.
            // A missing leaf following an ambiguous unlink gets a named hold.
            if absent(&self.directory, &self.name) {
                let _ = self
                    .directory
                    .publish_with_identity(&self.name, recovery, &mut false);
            }
            return Err(error.into());
        }
        Ok(())
    }
}

fn publish(directory: &Directory, name: &OsStr, uid: u32, bytes: &[u8]) -> Result<(u64, u64)> {
    let identity = directory.publish_with_identity(name, bytes, &mut false)?;
    if confirm(directory, name, uid, bytes)? != identity {
        return Err("own maintenance record changed".into());
    }
    Ok(identity)
}

fn absent(directory: &Directory, name: &OsStr) -> bool {
    directory.entry(name).is_err_and(|error| {
        matches!(error, crate::worker_storage::StorageError::Io(error)
            if error.kind() == io::ErrorKind::NotFound)
    })
}

fn confirm(directory: &Directory, name: &OsStr, uid: u32, expected: &[u8]) -> Result<(u64, u64)> {
    let mut file = directory.existing_file(name, libc::O_RDONLY)?;
    let observed = file.metadata()?;
    if !observed.is_file()
        || observed.nlink() != 1
        || observed.uid() != uid
        || observed.mode() & 0o7777 != 0o600
        || observed.len() != expected.len() as u64
    {
        return Err("private maintenance record changed".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(expected.len() as u64 + 1)
        .read_to_end(&mut bytes)?;
    let named = directory.entry(name)?;
    let id = (observed.dev(), observed.ino());
    if bytes != expected
        || id != (named.device, named.inode)
        || named.mode != libc::S_IFREG | 0o600
        || named.uid != uid
        || named.links != 1
        || named.size != observed.len()
        || named.mtime != (observed.mtime(), observed.mtime_nsec())
        || named.ctime != (observed.ctime(), observed.ctime_nsec())
    {
        return Err("private maintenance record changed".into());
    }
    native::close(file)?;
    Ok(id)
}
