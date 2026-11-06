//! Anchored storage-purpose resources; no new unsafe syscall implementation.
use super::error::{Result, StorageFault, finalized, need};
use crate::native;
use nix::sys::stat::{Mode, mkdirat};
use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{self, Write},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
};

pub(super) fn close(file: File) -> Result<()> {
    native::close(file).map_err(Into::into)
}
pub(super) struct Directory {
    file: File,
    path: PathBuf,
    uid: u32,
}
fn same(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}
fn private(info: &fs::Metadata, uid: u32) -> bool {
    info.is_dir() && info.uid() == uid && info.mode() & 0o077 == 0
}
fn walk(path: &Path) -> Result<File> {
    let mut parent = native::open_at(
        libc::AT_FDCWD,
        OsStr::new("/"),
        libc::O_PATH | libc::O_DIRECTORY,
    )?;
    for part in path.components().skip(1) {
        let child = native::open_at(
            parent.as_raw_fd(),
            part.as_os_str(),
            libc::O_PATH | libc::O_DIRECTORY,
        );
        let closed = close(parent);
        parent = match (child, closed) {
            (Ok(child), Ok(())) => child,
            (Err(error), closed) => return finalized(Err(error.into()), closed),
            (Ok(child), Err(error)) => return finalized(Err(error), close(child)),
        };
    }
    Ok(parent)
}
impl Directory {
    pub(super) fn open(path: &Path, uid: u32) -> Result<Self> {
        reverie_store::storage_identity::canonical(path)?;
        let file = walk(path)?;
        let checked = file
            .metadata()
            .map_err(Into::into)
            .and_then(|m| need(private(&m, uid), StorageFault::PrivateDirectory));
        if let Err(error) = checked {
            return finalized(Err(error), close(file));
        }
        let result = Self {
            file,
            path: path.to_owned(),
            uid,
        };
        if let Err(error) = result.check() {
            return finalized(Err(error), result.close());
        }
        Ok(result)
    }
    pub(super) fn ensure(path: &Path, uid: u32, effects: &mut bool) -> Result<Self> {
        reverie_store::storage_identity::canonical(path)?;
        let parent_path = path.parent().unwrap_or(Path::new("/"));
        let parent = walk(parent_path)?;
        let created = mkdirat(
            &parent,
            path.file_name().unwrap_or(OsStr::new(".")),
            Mode::S_IRWXU,
        );
        let result = match created {
            Ok(()) => {
                *effects = true;
                sync(&parent)
            }
            Err(nix::errno::Errno::EEXIST) => Ok(()),
            Err(error) => {
                *effects = true;
                Err(io::Error::from(error).into())
            }
        };
        finalized(result, close(parent))?;
        Self::open(path, uid)
    }
    pub(super) fn check(&self) -> Result<()> {
        let held = self.file.metadata()?;
        let named = fs::symlink_metadata(&self.path)?;
        need(
            private(&held, self.uid) && private(&named, self.uid) && same(&held, &named),
            StorageFault::DirectoryChanged,
        )?;
        reverie_store::storage_identity::canonical(&self.path)?;
        Ok(())
    }
    pub(super) fn lock_file(&self, name: &OsStr, effects: &mut bool) -> Result<File> {
        self.check()?;
        // O_NONBLOCK prevents a malicious FIFO leaf from blocking before fstat.
        // This has no effect on a valid regular flock file.
        *effects = true;
        Ok(native::open_at_mode(
            self.file.as_raw_fd(),
            name,
            libc::O_RDWR | libc::O_CREAT | libc::O_NONBLOCK,
            0o600,
        )?)
    }
    pub(super) fn file_current(&self, file: &File, name: &OsStr) -> Result<()> {
        self.check()?;
        let held = file.metadata()?;
        let named = fs::symlink_metadata(self.path.join(name))?;
        need(
            same(&held, &named)
                && held.is_file()
                && named.is_file()
                && held.uid() == self.uid
                && held.nlink() == 1
                && held.mode() & 0o077 == 0,
            StorageFault::LockCustody,
        )
    }
    pub(super) fn publish(&self, name: &OsStr, bytes: &[u8], effects: &mut bool) -> Result<()> {
        self.check()?;
        *effects = true;
        let mut file = native::open_at_mode(
            self.file.as_raw_fd(),
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
            0o600,
        )?;
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            self.file_current(&file, name)?;
            #[cfg(test)]
            super::tests::publication_written(&self.path.join(name))?;
            self.file_current(&file, name)
        })();
        finalized(result, close(file))?;
        sync(&self.file)?;
        self.check()
    }
    pub(super) fn close(self) -> Result<()> {
        close(self.file)
    }
}
fn sync(parent: &File) -> Result<()> {
    let readable = native::open_at(
        parent.as_raw_fd(),
        OsStr::new("."),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    finalized(readable.sync_all().map_err(Into::into), close(readable))
}
pub(super) fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e)
            if e.kind() == io::ErrorKind::NotFound
                || matches!(
                    e.raw_os_error(),
                    Some(libc::ENOTDIR | libc::ELOOP | libc::EBADF)
                ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
}
