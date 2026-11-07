use super::{Result, ancestors::Ancestors, combine, directory::Directory, require, retain_file};
use crate::native;
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(super) enum Observed {
    Directory(Directory),
    File(Regular),
}
impl Observed {
    pub(super) fn capture(path: &Path) -> Result<Self> {
        let canonical = fs::canonicalize(path)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&canonical)?;
        let checked = (|| {
            let info = file.metadata()?;
            require(info.is_file() || info.is_dir(), "SNAPSHOT_BIND_TYPE")?;
            Ok(info)
        })();
        let info = combine(checked, native::close(file).map_err(Into::into))?;
        if info.is_dir() {
            return Ok(Self::Directory(Directory::open(path)?));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&canonical)?;
        let (file, (info, parents)) = retain_file(file, |file| {
            Ok((file.metadata()?, Ancestors::capture(&canonical)?))
        })?;
        let regular = Regular {
            stamp: native::Stamp::of(&info),
            identity: (info.dev(), info.ino()),
            file,
            parents,
            canonical,
            original: path.to_path_buf(),
        };
        let regular = Self::File(regular);
        match regular.verify() {
            Ok(()) => Ok(regular),
            Err(error) => combine(Err(error), regular.close()),
        }
    }
    pub(super) fn verify(&self) -> Result<()> {
        match self {
            Self::Directory(value) => value.check(),
            Self::File(value) => value.verify(),
        }
    }
    pub(super) fn path(&self) -> &Path {
        match self {
            Self::Directory(value) => value.path(),
            Self::File(value) => &value.canonical,
        }
    }
    pub(super) fn identity(&self) -> (u64, u64) {
        match self {
            Self::Directory(value) => value.identity(),
            Self::File(value) => value.identity,
        }
    }
    pub(super) fn close(self) -> Result<()> {
        match self {
            Self::Directory(value) => value.close(),
            Self::File(value) => combine(
                native::close(value.file).map_err(Into::into),
                value.parents.close(),
            ),
        }
    }
}
pub(super) struct Regular {
    file: File,
    canonical: PathBuf,
    original: PathBuf,
    stamp: native::Stamp,
    identity: (u64, u64),
    parents: Ancestors,
}
impl Regular {
    fn verify(&self) -> Result<()> {
        self.parents.verify()?;
        let held = self.file.metadata()?;
        let named = fs::symlink_metadata(&self.canonical)?;
        require(
            held.is_file()
                && named.is_file()
                && native::Stamp::of(&held) == self.stamp
                && native::Stamp::of(&named) == self.stamp
                && fs::canonicalize(&self.original)? == self.canonical,
            "SNAPSHOT_BIND_CHANGED",
        )
    }
}
