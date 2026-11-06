//! Anchored storage-purpose resources; no new unsafe syscall implementation.
mod label;
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
pub(crate) struct Directory {
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
    pub(crate) fn write_scratch_label(
        &self,
        paths: &super::StoragePaths,
        effects: &mut bool,
    ) -> Result<super::LabelDisposition> {
        label::write(self, paths, effects)
    }
    pub(crate) fn nix_log_writer(&self) -> Result<File> {
        self.check()?;
        Ok(native::open_at_mode(
            self.file.as_raw_fd(),
            OsStr::new(".reverie-nix-prepare.log"),
            libc::O_WRONLY | libc::O_CREAT | libc::O_NONBLOCK,
            0o600,
        )?)
    }
    pub(crate) fn nix_log_anchor(&self) -> Result<File> {
        self.check()?;
        Ok(native::open_at(
            self.file.as_raw_fd(),
            OsStr::new(".reverie-nix-prepare.log"),
            libc::O_PATH,
        )?)
    }
    pub(crate) fn open(path: &Path, uid: u32) -> Result<Self> {
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
    pub(crate) fn check(&self) -> Result<()> {
        let held = self.file.metadata()?;
        let named = fs::symlink_metadata(&self.path)?;
        need(
            private(&held, self.uid) && private(&named, self.uid) && same(&held, &named),
            StorageFault::DirectoryChanged,
        )?;
        reverie_store::storage_identity::canonical(&self.path)?;
        Ok(())
    }
    pub(crate) fn lock_file(&self, name: &OsStr, effects: &mut bool) -> Result<File> {
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
        self.private_file_current(file, name, true)
    }
    /// Nix's original session lock permits hard links; it is not the stable
    /// employee lock or an exclusive publication marker.
    pub(crate) fn nix_lock_current(&self, file: &File, name: &OsStr) -> Result<()> {
        self.private_file_current(file, name, false)
    }
    fn private_file_current(&self, file: &File, name: &OsStr, single_link: bool) -> Result<()> {
        self.check()?;
        let held = file.metadata()?;
        let named = fs::symlink_metadata(self.path.join(name))?;
        need(
            same(&held, &named)
                && held.is_file()
                && named.is_file()
                && held.uid() == self.uid
                && (!single_link || held.nlink() == 1)
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
    pub(crate) fn close(self) -> Result<()> {
        close(self.file)
    }
    /// Python Nix session/store mkdir policy. It deliberately does not inherit
    /// the durable employee-publication fsync phase or create all parents0700.
    pub(crate) fn nix_directory(
        path: &Path,
        uid: u32,
        parents: bool,
        effects: &mut bool,
    ) -> Result<Self> {
        reverie_store::storage_identity::canonical(path)?;
        nix_mkdir(path, Mode::S_IRWXU, parents, effects)?;
        Self::open(path, uid)
    }
}
fn nix_mkdir(path: &Path, mode: Mode, parents: bool, effects: &mut bool) -> Result<()> {
    let parent_path = path.parent().unwrap_or(Path::new("/"));
    let parent = match walk(parent_path) {
        Ok(parent) => parent,
        Err(super::StorageError::Io(error))
            if parents && error.kind() == io::ErrorKind::NotFound =>
        {
            // pathlib parent.mkdir(parents=True, exist_ok=True) uses its own
            // default0777 mode, not the child's explicitly requested0700.
            nix_mkdir(parent_path, Mode::from_bits_truncate(0o777), true, effects)?;
            walk(parent_path)?
        }
        Err(error) => return Err(error),
    };
    let result = match mkdirat(&parent, path.file_name().unwrap_or(OsStr::new(".")), mode) {
        Ok(()) => {
            *effects = true;
            Ok(())
        }
        Err(nix::errno::Errno::EEXIST) => Ok(()),
        Err(error) => {
            *effects = true;
            Err(io::Error::from(error).into())
        }
    };
    finalized(result, close(parent))
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
