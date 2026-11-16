//! Safe owned-descriptor store boundary. No command or host effect transport.
use crate::{Error, Result};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
    unistd::{close, geteuid},
};
use rustix::fs::{FlockOperation, RenameFlags, flock, renameat, renameat_with};
use std::{
    fs::{self, DirBuilder, File},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) struct Directory {
    file: File,
    path: PathBuf,
    identity: (u64, u64),
}
impl Directory {
    pub(crate) fn stage(target: &Path) -> Result<Self> {
        let parent = Self::open(target.parent().ok_or(Error::Invalid)?)?;
        let name = target
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(Error::Invalid)?;
        if name.is_empty()
            || name.len() > 100
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Error::Invalid);
        }
        match fs::symlink_metadata(target) {
            Ok(_) => return Err(Error::ExistingCompany),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::Storage),
        }
        let result = Self::create(
            &parent
                .path
                .join(format!(".{name}.bootstrap-{}", crate::document::new_id()?)),
        )?;
        parent.current()?;
        Ok(result)
    }
    pub(crate) fn publish_fresh(self, target: &Path) -> Result<()> {
        self.current()?;
        let parent = Self::open(target.parent().ok_or(Error::Invalid)?)?;
        if self.path.parent() != Some(parent.path.as_path()) {
            return Err(Error::Storage);
        }
        let source = self.path.file_name().ok_or(Error::Invalid)?;
        let name = target.file_name().ok_or(Error::Invalid)?;
        let named = rustix::fs::statat(&parent.file, source, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|_| Error::Storage)?;
        if (named.st_dev, named.st_ino) != self.identity {
            return Err(Error::Storage);
        }
        self.file.sync_all().map_err(|_| Error::Storage)?;
        renameat_with(
            &parent.file,
            source,
            &parent.file,
            name,
            RenameFlags::NOREPLACE,
        )
        .map_err(|error| {
            if error == rustix::io::Errno::EXIST {
                Error::ExistingCompany
            } else {
                Error::PublicationUnconfirmed
            }
        })?;
        let synced = parent
            .file
            .sync_all()
            .map_err(|_| Error::PublicationUnconfirmed);
        let closed = close(self.file)
            .and(close(parent.file))
            .map_err(|_| Error::PublicationUnconfirmed);
        synced.and(closed)
    }
    pub(crate) fn create(path: &Path) -> Result<Self> {
        DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    Error::ExistingCompany
                } else {
                    Error::Storage
                }
            })?;
        Self::open(path)
    }
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let file = File::from(
            open(
                path,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| Error::Storage)?,
        );
        let meta = file.metadata().map_err(|_| Error::Storage)?;
        if !meta.is_dir() || meta.mode() & 0o7777 != 0o700 || meta.uid() != geteuid().as_raw() {
            return Err(Error::Storage);
        }
        let result = Self {
            identity: (meta.dev(), meta.ino()),
            file,
            path: path.to_owned(),
        };
        result.current()?;
        Ok(result)
    }
    pub(crate) fn current(&self) -> Result<()> {
        let named = fs::symlink_metadata(&self.path).map_err(|_| Error::Storage)?;
        if !named.is_dir()
            || (named.dev(), named.ino()) != self.identity
            || named.uid() != geteuid().as_raw()
            || named.mode() & 0o7777 != 0o700
        {
            return Err(Error::Storage);
        }
        Ok(())
    }
    fn check(file: &File) -> Result<()> {
        let m = file.metadata().map_err(|_| Error::Storage)?;
        if !m.is_file()
            || m.uid() != geteuid().as_raw()
            || m.mode() & 0o7777 != 0o600
            || m.nlink() != 1
            || m.len() > MAX_BYTES
        {
            return Err(Error::Storage);
        }
        Ok(())
    }
    fn file(&self, name: &str, flags: OFlag) -> Result<File> {
        self.current()?;
        let file = File::from(
            openat(
                &self.file,
                name,
                flags | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::S_IRUSR | Mode::S_IWUSR,
            )
            .map_err(|_| Error::Storage)?,
        );
        Self::check(&file)?;
        Ok(file)
    }
    pub(crate) fn read(&self, name: &str) -> Result<Vec<u8>> {
        let mut file = self.file(name, OFlag::O_RDONLY)?;
        let result = (|| {
            let before = file.metadata().map_err(|_| Error::Storage)?;
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| Error::Storage)?;
            let after = file.metadata().map_err(|_| Error::Storage)?;
            if bytes.len() as u64 > MAX_BYTES
                || before.len() != after.len()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.mtime() != after.mtime()
            {
                return Err(Error::Storage);
            }
            self.current()?;
            Ok(bytes)
        })();
        let closed = close(file).map_err(|_| Error::Storage);
        result.and_then(|bytes| closed.map(|()| bytes))
    }
    pub(crate) fn create_file(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let mut file = self.file(name, OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL)?;
        let result = file
            .write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| Error::Storage);
        let closed = close(file).map_err(|_| Error::Storage);
        result.and(closed)?;
        self.file
            .sync_all()
            .map_err(|_| Error::PublicationUnconfirmed)
    }
    pub(crate) fn lock(&self) -> Result<File> {
        self.current()?;
        // A separately opened description is required: dup/try_clone would share
        // flock ownership, and a mutable child lock could split genuine writers.
        let file = File::from(
            openat(
                &self.file,
                ".",
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| Error::Storage)?,
        );
        self.require_lock(&file)?;
        if flock(&file, FlockOperation::NonBlockingLockExclusive).is_err() {
            let _ = close(file);
            return Err(Error::Busy);
        }
        Ok(file)
    }
    pub(crate) fn unlock(&self, file: File) -> Result<()> {
        let unlocked = flock(&file, FlockOperation::Unlock).map_err(|_| Error::Storage);
        let closed = close(file).map_err(|_| Error::Storage);
        unlocked.and(closed)
    }
    pub(crate) fn require_lock(&self, file: &File) -> Result<()> {
        self.current()?;
        let held = file.metadata().map_err(|_| Error::Storage)?;
        if !held.is_dir()
            || (held.dev(), held.ino()) != self.identity
            || held.uid() != geteuid().as_raw()
            || held.mode() & 0o7777 != 0o700
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub(crate) fn publish(&self, bytes: &[u8], current: impl Fn() -> Result<()>) -> Result<()> {
        if bytes.len() as u64 > MAX_BYTES {
            return Err(Error::Capacity);
        }
        let temporary = format!("company-{}.tmp", crate::document::new_id()?);
        self.create_file(&temporary, bytes)?;
        #[cfg(test)]
        crate::store::tests::before_publish(&self.path)?;
        current()?;
        #[cfg(test)]
        crate::store::tests::after_current(&self.path)?;
        renameat(&self.file, temporary.as_str(), &self.file, "company.json")
            .map_err(|_| Error::PublicationUnconfirmed)?;
        #[cfg(test)]
        if crate::store::tests::lose_after_rename(&self.path) {
            return Err(Error::PublicationUnconfirmed);
        }
        self.file
            .sync_all()
            .map_err(|_| Error::PublicationUnconfirmed)
    }
}
