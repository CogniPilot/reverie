//! Reviewed Linux syscall boundary for existing private store custody.
//! Unsafe is confined here; safe callers hold owned files and typed close roles.
#![allow(unsafe_code)]

use crate::error::{Result, StoreError, StoreFault, finalized, need};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stamp {
    pub(crate) dev: u64,
    pub(crate) ino: u64,
    pub(crate) size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
    mode: u32,
    uid: u32,
    links: u64,
}
impl Stamp {
    pub(crate) fn from_metadata(meta: &Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            size: meta.len(),
            mtime: (meta.mtime(), meta.mtime_nsec()),
            ctime: (meta.ctime(), meta.ctime_nsec()),
            mode: meta.mode(),
            uid: meta.uid(),
            links: meta.nlink(),
        }
    }
    pub(crate) fn same_inode(&self, other: &Self) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
    fn private_directory(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFDIR
            && self.mode & 0o7777 == 0o700
            && self.uid == uid()
    }
    pub(crate) fn private_file(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFREG
            && self.mode & 0o7777 == 0o600
            && self.uid == uid()
            && self.links == 1
    }
}
fn uid() -> u32 {
    // SAFETY: geteuid has no pointer or lifetime preconditions.
    unsafe { libc::geteuid() }
}
fn name(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput.into())
}
fn open_at(parent: i32, path: &OsStr, flags: i32, mode: libc::mode_t) -> io::Result<File> {
    let path = name(path)?;
    // SAFETY: path is terminated, and successful openat returns one new owned fd.
    let fd = unsafe {
        libc::openat(
            parent,
            path.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            mode,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CloseRole {
    Walk,
    Data,
    Lock,
    Temporary,
    TemporaryAnchor,
    Recheck,
    Store,
}
pub(crate) fn close(file: File, role: CloseRole, path: &Path) -> Result<()> {
    let fd = file.into_raw_fd();
    // SAFETY: ownership was consumed before this single close; errors never retry it.
    let result = if unsafe { libc::close(fd) } == 0 {
        Ok(())
    } else {
        Err(StoreError::io(io::Error::last_os_error()))
    };
    #[cfg(test)]
    crate::faults::closed(role, path)?;
    #[cfg(not(test))]
    let _ = (role, path);
    result
}
pub(crate) fn private_stamp(file: &File) -> Result<Stamp> {
    let value = Stamp::from_metadata(&file.metadata().map_err(StoreError::io)?);
    need(value.private_file(), StoreFault::PrivateFile)?;
    Ok(value)
}
fn chmod_private(file: &File, path: &Path) -> Result<()> {
    #[cfg(test)]
    crate::faults::hit(crate::faults::Point::CreatedFilePermissions, path)?;
    #[cfg(not(test))]
    let _ = path;
    // SAFETY: fchmod acts only on the borrowed live descriptor; ownership is retained.
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } == 0 {
        Ok(())
    } else {
        Err(StoreError::io(io::Error::last_os_error()))
    }
}
pub(crate) struct Directory {
    file: File,
    path: PathBuf,
    identity: Stamp,
}
impl Directory {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        need(
            path.is_absolute()
                && path
                    .components()
                    .all(|part| matches!(part, Component::RootDir | Component::Normal(_))),
            StoreFault::InvalidPath,
        )?;
        let mut file = open_at(
            libc::AT_FDCWD,
            OsStr::new("/"),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )
        .map_err(StoreError::io)?;
        for part in path.components().skip(1) {
            let child = open_at(
                file.as_raw_fd(),
                part.as_os_str(),
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )
            .map_err(StoreError::io)?;
            if let Err(error) = close(file, CloseRole::Walk, path) {
                return finalized(Err(error), close(child, CloseRole::Walk, path));
            }
            file = child;
        }
        let identity = Stamp::from_metadata(&file.metadata().map_err(StoreError::io)?);
        need(identity.private_directory(), StoreFault::PrivateDirectory)?;
        Ok(Self {
            file,
            path: path.to_owned(),
            identity,
        })
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn check(&self) -> Result<()> {
        let other = Self::open(&self.path)
            .map_err(|_| StoreError::Refused(StoreFault::DirectoryRebound))?;
        let same = self.identity.same_inode(&other.identity);
        other.close_as(CloseRole::Recheck)?;
        need(same, StoreFault::DirectoryRebound)
    }
    pub(crate) fn stamp(&self, leaf: &str) -> Result<Option<Stamp>> {
        let leaf = name(OsStr::new(leaf)).map_err(StoreError::io)?;
        let mut meta: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: meta is writable storage of the stat ABI size; leaf is terminated.
        if unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                leaf.as_ptr(),
                &mut meta,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(StoreError::io(error))
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
    pub(crate) fn read_file(&self, leaf: &str) -> Result<Option<File>> {
        match open_at(
            self.file.as_raw_fd(),
            OsStr::new(leaf),
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        ) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(StoreError::io(error)),
        }
    }
    pub(crate) fn create_file(&self, leaf: &str) -> Result<File> {
        let file = open_at(
            self.file.as_raw_fd(),
            OsStr::new(leaf),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .map_err(StoreError::io)?;
        if let Err(error) = chmod_private(&file, &self.path) {
            return finalized(
                Err(StoreError::PreparationRetained {
                    cause: Box::new(error),
                }),
                close(file, CloseRole::Temporary, &self.path),
            );
        }
        Ok(file)
    }
    pub(crate) fn pin_file(&self, leaf: &str) -> Result<File> {
        open_at(self.file.as_raw_fd(), OsStr::new(leaf), libc::O_PATH, 0).map_err(StoreError::io)
    }
    pub(crate) fn lock(&self) -> Result<File> {
        let file = match self.create_file("profiles.lock") {
            Ok(file) => file,
            Err(StoreError::Io { source, .. }) if source.kind() == io::ErrorKind::AlreadyExists => {
                self.read_write_lock()?
            }
            Err(error) => return Err(error),
        };
        let result = self.lock_file(&file);
        if let Err(error) = result {
            return finalized(Err(error), close(file, CloseRole::Lock, &self.path));
        }
        Ok(file)
    }
    fn read_write_lock(&self) -> Result<File> {
        open_at(
            self.file.as_raw_fd(),
            OsStr::new("profiles.lock"),
            libc::O_RDWR | libc::O_NONBLOCK,
            0,
        )
        .map_err(StoreError::io)
    }
    fn lock_file(&self, file: &File) -> Result<()> {
        self.check_lock(file)?;
        // SAFETY: flock locks the held descriptor only; its lifetime remains owned.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let source = io::Error::last_os_error();
            return Err(StoreError::Io {
                fault: StoreFault::LockBusy,
                source,
            });
        }
        self.check()?;
        self.check_lock(file)
    }
    pub(crate) fn check_lock(&self, file: &File) -> Result<()> {
        let value = private_stamp(file)?;
        need(
            self.stamp("profiles.lock")?.as_ref() == Some(&value),
            StoreFault::LockRebound,
        )
    }
    pub(crate) fn publish(&self, source: &str, absent: bool) -> Result<()> {
        #[cfg(test)]
        crate::faults::hit(crate::faults::Point::BeforeRename, &self.path)?;
        let source = name(OsStr::new(source)).map_err(StoreError::io)?;
        let target = name(OsStr::new("profiles.json")).map_err(StoreError::io)?;
        let flags = if absent { libc::RENAME_NOREPLACE } else { 0 };
        // SAFETY: both names are terminated leaves in this held private directory.
        if unsafe {
            libc::renameat2(
                self.file.as_raw_fd(),
                source.as_ptr(),
                self.file.as_raw_fd(),
                target.as_ptr(),
                flags,
            )
        } != 0
        {
            return Err(StoreError::io(io::Error::last_os_error()));
        }
        #[cfg(test)]
        crate::faults::hit(crate::faults::Point::AfterRename, &self.path)?;
        Ok(())
    }
    pub(crate) fn sync(&self) -> Result<()> {
        #[cfg(test)]
        crate::faults::hit(crate::faults::Point::DirectorySync, &self.path)?;
        self.file.sync_all().map_err(StoreError::io)
    }
    pub(crate) fn remove_temporary(&self, leaf: &str, owned: &Stamp) -> Result<()> {
        let Some(current) = self.stamp(leaf)? else {
            return Ok(());
        };
        need(current.same_inode(owned), StoreFault::TemporaryRebound)?;
        let leaf = name(OsStr::new(leaf)).map_err(StoreError::io)?;
        // SAFETY: unlinkat removes only the verified owned leaf, never a directory tree.
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), leaf.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(StoreError::io(io::Error::last_os_error()))
        }
    }
    pub(crate) fn close(self) -> Result<()> {
        self.close_as(CloseRole::Store)
    }
    fn close_as(self, role: CloseRole) -> Result<()> {
        close(self.file, role, &self.path)
    }
}
pub(crate) fn random_temporary_name() -> Result<String> {
    let mut bytes = [0u8; 16];
    // SAFETY: bytes is writable for exactly its supplied length; no descriptor is returned.
    let count = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if count != bytes.len() as isize {
        return Err(StoreError::io(io::Error::last_os_error()));
    }
    Ok(format!(
        ".profiles-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}
pub(crate) fn read_bounded(file: &mut File, maximum: usize) -> Result<Vec<u8>> {
    #[cfg(test)]
    let mut chunked = Chunked(file);
    #[cfg(test)]
    let file = &mut chunked;
    let mut bytes = Vec::new();
    (&mut *file)
        .take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(StoreError::io)?;
    need(bytes.len() <= maximum, StoreFault::StoreBound)?;
    Ok(bytes)
}
#[cfg(test)]
struct Chunked<'a>(&'a mut File);
#[cfg(test)]
impl Read for Chunked<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let size = crate::faults::read_limit(buffer.len());
        self.0.read(&mut buffer[..size])
    }
}
pub(crate) fn write_all(file: &mut File, bytes: &[u8], path: &Path) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        #[cfg(test)]
        let maximum = crate::faults::write_limit(bytes.len() - offset, path)?;
        #[cfg(not(test))]
        let maximum = bytes.len() - offset;
        let written = file
            .write(&bytes[offset..offset + maximum])
            .map_err(StoreError::io)?;
        need(written > 0, StoreFault::Io)?;
        offset += written;
    }
    #[cfg(test)]
    crate::faults::hit(crate::faults::Point::FileSync, path)?;
    #[cfg(not(test))]
    let _ = path;
    file.sync_all().map_err(StoreError::io)
}
pub(crate) fn rewind(file: &mut File) -> Result<()> {
    file.seek(SeekFrom::Start(0)).map_err(StoreError::io)?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn fifo(path: &Path) {
    let path = name(path.as_os_str()).expect("fixture path");
    // SAFETY: test-only terminated owned fixture path; no descriptor is returned.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
}
