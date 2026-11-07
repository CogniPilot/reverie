use super::{Result, ancestors::Ancestors, combine, require, retain_file};
use crate::native;
use std::{
    fs::{self, File, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

pub(super) struct Directory {
    file: Option<File>,
    path: PathBuf,
    original: PathBuf,
    identity: (u64, u64),
    security: (u32, u32, u32),
    parents: Ancestors,
}
impl Directory {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let canonical = fs::canonicalize(path)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&canonical)?;
        let (file, (metadata, parents)) = retain_file(file, |file| {
            Ok((file.metadata()?, Ancestors::capture(&canonical)?))
        })?;
        let directory = Self {
            identity: (metadata.dev(), metadata.ino()),
            security: (metadata.uid(), metadata.gid(), metadata.mode()),
            file: Some(file),
            parents,
            path: canonical,
            original: path.to_path_buf(),
        };
        match directory.check() {
            Ok(()) => Ok(directory),
            Err(error) => combine(Err(error), directory.close()),
        }
    }
    pub(super) fn create(path: &Path) -> Result<Self> {
        let parent = Self::open(
            path.parent()
                .ok_or_else(|| super::SnapshotError::refused("SNAPSHOT_DESTINATION"))?,
        )?;
        let result = (|| {
            let info = parent.file().metadata()?;
            require(
                info.uid() == native::uid() && info.mode() & 0o022 == 0,
                "SNAPSHOT_DESTINATION_CUSTODY",
            )?;
            let name = path
                .file_name()
                .ok_or_else(|| super::SnapshotError::refused("SNAPSHOT_DESTINATION"))?;
            let anchored = parent.fd_path().join(name);
            fs::DirBuilder::new().mode(0o700).create(&anchored)?;
            let directory = Self::open(path)?;
            let checked = (|| {
                let info = directory.file().metadata()?;
                require(
                    info.uid() == native::uid() && info.mode() & 0o777 == 0o700,
                    "SNAPSHOT_DESTINATION_CUSTODY",
                )?;
                parent.check()?;
                parent.sync()?;
                Ok(())
            })();
            match checked {
                Ok(()) => Ok(directory),
                Err(error) => combine(Err(error), directory.close()),
            }
        })();
        match (result, parent.close()) {
            (Ok(directory), Ok(())) => Ok(directory),
            (Ok(directory), Err(error)) => combine(Err(error), directory.close()),
            (Err(error), closed) => combine(Err(error), closed),
        }
    }
    pub(super) fn create_child(&self, name: &str) -> Result<Self> {
        self.check()?;
        Self::create(&self.path.join(name))
    }
    pub(super) fn child_directory(&self, name: &str) -> Result<Self> {
        self.child(Path::new(name))
    }
    pub(super) fn child(&self, name: &Path) -> Result<Self> {
        let file = native::open_at(
            self.file().as_raw_fd(),
            name.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let (file, (info, parents)) = retain_file(file, |file| {
            Ok((file.metadata()?, Ancestors::capture(&self.path.join(name))?))
        })?;
        let child = Self {
            identity: (info.dev(), info.ino()),
            security: (info.uid(), info.gid(), info.mode()),
            parents,
            file: Some(file),
            path: self.path.join(name),
            original: self.path.join(name),
        };
        match child.check() {
            Ok(()) => Ok(child),
            Err(error) => combine(Err(error), child.close()),
        }
    }
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
    pub(super) fn identity(&self) -> (u64, u64) {
        self.identity
    }
    pub(super) fn fd_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.file().as_raw_fd()))
    }
    pub(super) fn file(&self) -> &File {
        self.file.as_ref().expect("live directory")
    }
    pub(super) fn check(&self) -> Result<()> {
        self.parents.verify()?;
        let held = self.file().metadata()?;
        let named = fs::symlink_metadata(&self.path)?;
        require(
            held.is_dir()
                && named.is_dir()
                && (held.dev(), held.ino()) == self.identity
                && (named.dev(), named.ino()) == self.identity
                && (held.uid(), held.gid(), held.mode()) == self.security
                && (named.uid(), named.gid(), named.mode()) == self.security
                && fs::canonicalize(&self.original)? == self.path,
            "SNAPSHOT_DIRECTORY_CHANGED",
        )
    }
    pub(super) fn create_file(&self, name: &str) -> Result<File> {
        self.check()?;
        Ok(native::open_at_mode(
            self.file().as_raw_fd(),
            name.as_ref(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?)
    }
    pub(super) fn temporary(&self) -> Result<File> {
        self.check()?;
        Ok(native::open_at_mode(
            self.file().as_raw_fd(),
            std::ffi::OsStr::new("."),
            libc::O_TMPFILE | libc::O_RDWR,
            0o600,
        )?)
    }
    pub(super) fn check_file(&self, name: &str, file: &File) -> Result<()> {
        let held = file.metadata()?;
        let named = fs::symlink_metadata(self.fd_path().join(name))?;
        require(
            held.is_file()
                && held.nlink() == 1
                && held.uid() == native::uid()
                && held.mode() & 0o777 == 0o600
                && native::Stamp::of(&held) == native::Stamp::of(&named),
            "SNAPSHOT_ARCHIVE_CUSTODY",
        )
    }
    pub(super) fn sync(&self) -> Result<()> {
        self.file().sync_all()?;
        self.check()
    }
    pub(super) fn close(mut self) -> Result<()> {
        combine(
            native::close(self.file.take().expect("live directory")).map_err(Into::into),
            self.parents.close(),
        )
    }
}
