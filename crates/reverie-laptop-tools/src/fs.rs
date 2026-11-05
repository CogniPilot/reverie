//! Descriptor-anchored Linux filesystem operations for one owned Cargo directory.
#![allow(unsafe_code)]

use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::ffi::OsStrExt;
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
fn cstring(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput.into())
}
fn open_at(parent: i32, name: &OsStr, flags: i32, mode: libc::mode_t) -> io::Result<File> {
    let name = cstring(name)?;
    // SAFETY: name is terminated, flags establish ownership of a fresh descriptor.
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
pub(super) fn close(file: File) -> io::Result<()> {
    let fd = file.into_raw_fd();
    // SAFETY: ownership has been consumed; this descriptor is never closed again.
    if unsafe { libc::close(fd) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
pub(super) fn uid() -> u32 {
    // SAFETY: getuid has no preconditions or mutable pointers.
    unsafe { libc::getuid() }
}
fn mkdir_at(parent: i32, name: &OsStr) -> io::Result<()> {
    let name = cstring(name)?;
    // SAFETY: parent is a held directory and name is a terminated child name.
    if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::AlreadyExists {
        Ok(())
    } else {
        Err(error)
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
            libc::AT_FDCWD,
            OsStr::new("/"),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
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
            mkdir_at(self.0.as_raw_fd(), name)?;
        }
        open_at(
            self.0.as_raw_fd(),
            name,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )
        .map(Self)
    }
    pub(super) fn metadata(&self) -> io::Result<Stamp> {
        self.0.metadata().map(|meta| Stamp::from_metadata(&meta))
    }
    pub(super) fn stamp(&self, name: &str) -> io::Result<Option<Stamp>> {
        let name = cstring(OsStr::new(name))?;
        let mut meta: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: meta is initialized writable storage for fstatat; name is terminated.
        if unsafe {
            libc::fstatat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                &mut meta,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(error)
            };
        }
        Ok(Some(Stamp {
            dev: meta.st_dev,
            ino: meta.st_ino,
            size: meta.st_size as u64,
            mtime: (meta.st_mtime, meta.st_mtime_nsec),
            ctime: (meta.st_ctime, meta.st_ctime_nsec),
            mode: meta.st_mode,
            uid: meta.st_uid,
            links: meta.st_nlink,
        }))
    }
    pub(super) fn read(&self, name: &str) -> io::Result<Option<File>> {
        match open_at(
            self.0.as_raw_fd(),
            OsStr::new(name),
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        ) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    pub(super) fn create(&self, name: &str) -> io::Result<File> {
        open_at(
            self.0.as_raw_fd(),
            OsStr::new(name),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
    }
    pub(super) fn lock(&self) -> io::Result<()> {
        // SAFETY: flock changes only the advisory lock on this live directory descriptor.
        if unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    pub(super) fn publish(&self, source: &str, destination: &str, absent: bool) -> io::Result<()> {
        let source = cstring(OsStr::new(source))?;
        let destination = cstring(OsStr::new(destination))?;
        let flags = if absent { libc::RENAME_NOREPLACE } else { 0 };
        // SAFETY: both entries are relative to our held directory; names are terminated.
        if unsafe {
            libc::renameat2(
                self.0.as_raw_fd(),
                source.as_ptr(),
                self.0.as_raw_fd(),
                destination.as_ptr(),
                flags,
            )
        } == 0
        {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    pub(super) fn remove_owned(&self, name: &str, owned: &Stamp) {
        let Ok(Some(current)) = self.stamp(name) else {
            return;
        };
        if !owned.same_inode(&current) {
            return;
        }
        let Ok(name) = cstring(OsStr::new(name)) else {
            return;
        };
        // SAFETY: unlinkat removes only this verified owned temporary leaf, never a tree.
        let _ = unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) };
    }
    pub(super) fn sync(&self) -> io::Result<()> {
        self.0.sync_all()
    }
    pub(super) fn close(self) -> io::Result<()> {
        close(self.0)
    }
}
