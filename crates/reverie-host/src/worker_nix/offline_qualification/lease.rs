//! Hold the exact existing broker flock files through offline store effects.
use super::{Result, Seat};
use crate::{native, worker_storage::fs::Directory};
use reverie_contracts::worker_nix::offline_qualification::Target;
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File},
    io,
    os::unix::fs::MetadataExt,
    path::Path,
};

pub struct Lease {
    employee: HeldLock,
    session: HeldLock,
    home: Directory,
    store: Directory,
}

impl Lease {
    pub fn acquire(seat: &Seat, uid: u32) -> Result<Self> {
        let home = Directory::open(seat.paths.home(), uid)?;
        let store = Directory::open(seat.paths.nix(), uid)?;
        let employee = HeldLock::open(seat.locks.lock(), uid)?;
        let session = HeldLock::open(&seat.session_lock, uid)?;
        if employee.identity == session.identity {
            return Err("distinct native lock inodes required".into());
        }
        let lease = Self {
            employee,
            session,
            home,
            store,
        };
        lease.check()?;
        Ok(lease)
    }

    pub fn check(&self) -> Result<()> {
        self.employee.check()?;
        self.session.check()?;
        self.home.check()?;
        self.store.check()?;
        Ok(())
    }

    /// Close both held descriptions even if a close cannot be confirmed.
    /// The caller retains its durable fence until this returns success.
    pub fn close(self) -> Result<()> {
        let current = self.check();
        let session = self.session.close();
        let employee = self.employee.close();
        let store = self.store.close().map_err(Into::into);
        let home = self.home.close().map_err(Into::into);
        current.and(session).and(employee).and(store).and(home)
    }

    pub fn check_closure(&self, target: &Target) -> Result<()> {
        self.check()?;
        let store = self
            .store
            .existing_file(OsStr::new("store"), libc::O_RDONLY | libc::O_DIRECTORY)?;
        check_closure_entries(&store, target)?;
        let held = store.metadata()?;
        let named = self.store.entry(OsStr::new("store"))?;
        if (held.dev(), held.ino()) != (named.device, named.inode) {
            return Err("closure store directory replaced".into());
        }
        native::close(store)?;
        self.check()
    }
}

struct HeldLock {
    directory: Directory,
    name: OsString,
    file: File,
    uid: u32,
    identity: (u64, u64),
}

impl HeldLock {
    fn open(path: &Path, uid: u32) -> Result<Self> {
        let directory = Directory::open(path.parent().ok_or("lock directory required")?, uid)?;
        let name = path.file_name().ok_or("lock filename required")?.to_owned();
        let file = directory.existing_file(&name, libc::O_RDWR)?;
        let identity = lock_identity(&file.metadata()?, uid)?;
        file.try_lock().map_err(io::Error::from)?;
        let lock = Self {
            directory,
            name,
            file,
            uid,
            identity,
        };
        lock.check()?;
        Ok(lock)
    }

    fn check(&self) -> Result<()> {
        let held = lock_identity(&self.file.metadata()?, self.uid)?;
        let named = self.directory.entry(&self.name)?;
        if held != self.identity
            || held != (named.device, named.inode)
            || named.uid != self.uid
            || named.links != 1
            || named.mode != libc::S_IFREG | 0o600
        {
            return Err("native lock replaced or custody changed".into());
        }
        Ok(())
    }

    fn close(self) -> Result<()> {
        let file = native::close(self.file).map_err(Into::into);
        let directory = self.directory.close().map_err(Into::into);
        file.and(directory)
    }
}

fn lock_identity(info: &fs::Metadata, uid: u32) -> Result<(u64, u64)> {
    if !info.is_file() || info.uid() != uid || info.nlink() != 1 || info.mode() & 0o7777 != 0o600 {
        return Err("existing private native lock required".into());
    }
    Ok((info.dev(), info.ino()))
}

fn check_closure_entries(store: &File, target: &Target) -> Result<()> {
    for name in target.closure_names() {
        let stat = native::entry_stat(store, OsStr::new(name))?;
        if !matches!(
            stat.mode & libc::S_IFMT,
            libc::S_IFDIR | libc::S_IFREG | libc::S_IFLNK
        ) {
            return Err("closure path unavailable".into());
        }
    }
    Ok(())
}
