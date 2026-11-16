//! Descriptor-anchored Linux filesystem operations for one owned Cargo directory.

use rustix::fs::{self, AtFlags, FlockOperation, Mode, OFlags, RenameFlags};
use std::ffi::OsStr;
use std::fs::{File, Metadata};
use std::io;
use std::os::fd::AsFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};

pub(super) struct Directory(File);
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Stamp {
    pub(super) dev: u64,
    pub(super) ino: u64,
    pub(super) size: u64,
    pub(super) mtime: (i64, i64),
    pub(super) ctime: (i64, i64),
    pub(super) mode: u32,
    pub(super) uid: u32,
    pub(super) links: u64,
}
impl Stamp {
    pub(super) fn from_metadata(meta: &Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            size: meta.size(),
            mtime: (meta.mtime(), meta.mtime_nsec()),
            ctime: (meta.ctime(), meta.ctime_nsec()),
            mode: meta.mode(),
            uid: meta.uid(),
            links: meta.nlink(),
        }
    }
    pub(super) fn same_inode(&self, other: &Self) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
    pub(super) fn owned_directory(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFDIR && self.uid == uid() && self.mode & 0o022 == 0
    }
    pub(super) fn owned_file(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFREG
            && self.uid == uid()
            && self.links == 1
            && self.mode & 0o022 == 0
    }
}
// The pinned dependency's libc and raw-Linux backends expose different signedness.
// Normalize losslessly before the checked conversion used in our stable stamp.
fn nanoseconds(value: impl Into<i128>) -> io::Result<i64> {
    i64::try_from(value.into()).map_err(|_| io::ErrorKind::InvalidData.into())
}
fn open_at(parent: impl AsFd, name: &OsStr, flags: OFlags, mode: Mode) -> io::Result<File> {
    fs::openat(
        parent,
        name,
        flags | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        mode,
    )
    .map(File::from)
    .map_err(io::Error::from)
}
pub(super) fn close(file: File) -> io::Result<()> {
    // Consume sole ownership and check the single close without retrying a
    // descriptor number that may already have been released by the kernel.
    nix::unistd::close(file).map_err(io::Error::from)
}
pub(super) fn uid() -> u32 {
    rustix::process::getuid().as_raw()
}
fn mkdir_at(parent: impl AsFd, name: &OsStr) -> io::Result<()> {
    match fs::mkdirat(parent, name, Mode::from_raw_mode(0o700)) {
        Ok(()) | Err(rustix::io::Errno::EXIST) => Ok(()),
        Err(error) => Err(error.into()),
    }
}
impl Directory {
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute()
            || !path
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
            || path
                .components()
                .collect::<std::path::PathBuf>()
                .as_os_str()
                != path.as_os_str()
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mut current = Self(open_at(
            fs::CWD,
            OsStr::new("/"),
            OFlags::RDONLY | OFlags::DIRECTORY,
            Mode::empty(),
        )?);
        for part in path.components().skip(1) {
            let child = current.child(part.as_os_str(), false)?;
            current.close()?;
            current = child;
        }
        Ok(current)
    }
    pub(super) fn child(&self, name: &OsStr, create: bool) -> io::Result<Self> {
        if create {
            mkdir_at(&self.0, name)?;
        }
        open_at(
            &self.0,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY,
            Mode::empty(),
        )
        .map(Self)
    }
    pub(super) fn metadata(&self) -> io::Result<Stamp> {
        self.0.metadata().map(|meta| Stamp::from_metadata(&meta))
    }
    pub(super) fn stamp(&self, name: &str) -> io::Result<Option<Stamp>> {
        let meta = match fs::statat(&self.0, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(meta) => meta,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        Ok(Some(Stamp {
            dev: meta.st_dev,
            ino: meta.st_ino,
            size: meta.st_size as u64,
            mtime: (meta.st_mtime, nanoseconds(meta.st_mtime_nsec)?),
            ctime: (meta.st_ctime, nanoseconds(meta.st_ctime_nsec)?),
            mode: meta.st_mode,
            uid: meta.st_uid,
            links: meta.st_nlink,
        }))
    }
    pub(super) fn read(&self, name: &str) -> io::Result<Option<File>> {
        match open_at(
            &self.0,
            OsStr::new(name),
            OFlags::RDONLY | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    pub(super) fn create(&self, name: &str) -> io::Result<File> {
        open_at(
            &self.0,
            OsStr::new(name),
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o600),
        )
    }
    pub(super) fn pin(&self, name: &str) -> io::Result<File> {
        open_at(&self.0, OsStr::new(name), OFlags::PATH, Mode::empty())
    }
    pub(super) fn lock(&self) -> io::Result<()> {
        fs::flock(&self.0, FlockOperation::NonBlockingLockExclusive).map_err(io::Error::from)
    }
    pub(super) fn publish(&self, source: &str, destination: &str, absent: bool) -> io::Result<()> {
        let flags = if absent {
            RenameFlags::NOREPLACE
        } else {
            RenameFlags::empty()
        };
        fs::renameat_with(&self.0, source, &self.0, destination, flags).map_err(io::Error::from)
    }
    pub(super) fn remove_owned(&self, name: &str, owned: &Stamp) {
        let _ = self.remove_owned_checked(name, owned);
    }
    pub(super) fn remove_owned_checked(&self, name: &str, owned: &Stamp) -> io::Result<()> {
        let Some(current) = self.stamp(name)? else {
            return Ok(());
        };
        if !owned.same_inode(&current) {
            return Ok(());
        }
        fs::unlinkat(&self.0, name, AtFlags::empty()).map_err(io::Error::from)
    }
    pub(super) fn sync(&self) -> io::Result<()> {
        self.0.sync_all()
    }
    pub(super) fn close(self) -> io::Result<()> {
        close(self.0)
    }
}
