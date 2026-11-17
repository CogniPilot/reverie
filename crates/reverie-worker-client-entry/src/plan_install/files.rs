use super::{Failure, Result, join, need};
use nix::{
    fcntl::{AtFlags, OFlag, open, openat, readlinkat},
    sys::stat::{FileStat, Mode, SFlag, fstat, fstatat, mkdirat},
    unistd::{close, geteuid, symlinkat},
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    mem::MaybeUninit,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const DIR: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub(super) dev: u64,
    pub(super) ino: u64,
    pub(super) uid: u32,
    pub(super) gid: u32,
    pub(super) mode: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    identity: Identity,
    links: u64,
    bytes: i64,
    mt: i64,
    mtn: i64,
    ct: i64,
    ctn: i64,
}
impl From<FileStat> for Stamp {
    fn from(v: FileStat) -> Self {
        Self {
            identity: Identity {
                dev: v.st_dev,
                ino: v.st_ino,
                uid: v.st_uid,
                gid: v.st_gid,
                mode: v.st_mode,
            },
            links: v.st_nlink,
            bytes: v.st_size,
            mt: v.st_mtime,
            mtn: v.st_mtime_nsec,
            ct: v.st_ctime,
            ctn: v.st_ctime_nsec,
        }
    }
}
#[derive(Clone)]
enum Place {
    Root(PathBuf),
    Child(usize, String),
    Alias(usize),
}
struct Held {
    file: Option<File>,
    place: Place,
    identity: Identity,
    observed: Option<Stamp>,
}
pub(super) struct Files {
    held: Vec<Held>,
    end: Instant,
    #[cfg(test)]
    pub(super) lose_close: Option<usize>,
    #[cfg(test)]
    pub(super) close_calls: usize,
}
impl Files {
    pub(super) fn new() -> Self {
        Self {
            held: vec![],
            end: Instant::now() + Duration::from_secs(30),
            #[cfg(test)]
            lose_close: None,
            #[cfg(test)]
            close_calls: 0,
        }
    }
    pub(super) fn file(&self, id: usize) -> Result<&File> {
        self.held
            .get(id)
            .and_then(|v| v.file.as_ref())
            .ok_or_else(|| Failure::refused("file-owner"))
    }
    fn stamp(&self, id: usize) -> Result<Stamp> {
        fstat(self.file(id)?)
            .map(Stamp::from)
            .map_err(|e| Failure::new("file-stat", e))
    }
    fn named(&self, parent: usize, name: &str) -> Result<Stamp> {
        fstatat(self.file(parent)?, name, AtFlags::AT_SYMLINK_NOFOLLOW)
            .map(Stamp::from)
            .map_err(|e| Failure::new("named-stat", e))
    }
    fn add(&mut self, file: File, place: Place) -> Result<usize> {
        let id = self.held.len();
        self.held.push(Held {
            file: Some(file),
            place,
            observed: None,
            identity: Identity {
                dev: 0,
                ino: 0,
                uid: 0,
                gid: 0,
                mode: 0,
            },
        });
        self.held[id].identity = self.stamp(id)?.identity;
        Ok(id)
    }
    pub(super) fn deadline(&self) -> Result<()> {
        need(Instant::now() < self.end, "file-deadline")
    }
    pub(super) fn current(&self) -> Result<()> {
        self.deadline()?;
        for (id, node) in self.held.iter().enumerate() {
            if node.file.is_none() {
                continue;
            }
            let actual = self.stamp(id)?;
            need(
                actual.identity == node.identity
                    && node.observed.is_none_or(|stamp| stamp == actual),
                "file-currency",
            )?;
            let named = match &node.place {
                Place::Root(path) => {
                    fstatat(nix::fcntl::AT_FDCWD, path, AtFlags::AT_SYMLINK_NOFOLLOW)
                        .map(Stamp::from)
                        .map_err(|e| Failure::new("root-currency", e))?
                }
                Place::Child(parent, name) => self.named(*parent, name)?,
                Place::Alias(parent) => self.stamp(*parent)?,
            };
            need(named == actual, "named-currency")?;
        }
        Ok(())
    }
    pub(super) fn root(&mut self, path: &Path, uid: u32, private: bool) -> Result<usize> {
        let file = open(path, DIR, Mode::empty())
            .map(File::from)
            .map_err(|e| Failure::new("root-open", e))?;
        let id = self.add(file, Place::Root(path.to_owned()))?;
        self.directory(id, uid, private)?;
        self.current()?;
        Ok(id)
    }
    fn directory(&self, id: usize, uid: u32, private: bool) -> Result<()> {
        let v = self.stamp(id)?.identity;
        need(
            SFlag::from_bits_truncate(v.mode) == SFlag::S_IFDIR
                && v.uid == uid
                && v.mode & 0o022 == 0
                && (!private || v.mode & 0o7777 == 0o700),
            "directory-custody",
        )
    }
    pub(super) fn child(
        &mut self,
        parent: usize,
        name: &str,
        create: bool,
        private: bool,
    ) -> Result<usize> {
        need(super::input::component(name), "directory-component")?;
        self.current()?;
        if create {
            match mkdirat(self.file(parent)?, name, Mode::from_bits_truncate(0o700)) {
                Ok(()) => self.sync(parent)?,
                Err(nix::errno::Errno::EEXIST) => (),
                Err(e) => return Err(Failure::new("directory-create", e)),
            }
        }
        let file = openat(self.file(parent)?, name, DIR, Mode::empty())
            .map(File::from)
            .map_err(|e| Failure::new("directory-open", e))?;
        let id = self.add(file, Place::Child(parent, name.to_owned()))?;
        self.directory(id, geteuid().as_raw(), private)?;
        self.current()?;
        Ok(id)
    }
    pub(super) fn identity(&self, id: usize) -> Result<Identity> {
        Ok(self.stamp(id)?.identity)
    }
    pub(super) fn sync(&self, id: usize) -> Result<()> {
        self.file(id)?
            .sync_all()
            .map_err(|e| Failure::new("directory-sync", e))
    }
    pub(super) fn absent(&self, parent: usize, name: &str) -> Result<bool> {
        need(super::input::component(name), "file-component")?;
        self.current()?;
        match fstatat(self.file(parent)?, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(_) => Ok(false),
            Err(nix::errno::Errno::ENOENT) => Ok(true),
            Err(e) => Err(Failure::new("named-stat", e)),
        }
    }
    fn regular(&self, id: usize, private: bool) -> Result<Stamp> {
        let v = self.stamp(id)?;
        need(
            SFlag::from_bits_truncate(v.identity.mode) == SFlag::S_IFREG
                && v.identity.uid == geteuid().as_raw()
                && v.identity.mode & 0o022 == 0
                && v.links == 1
                && v.bytes >= 0
                && (!private || v.identity.mode & 0o7777 == 0o600),
            "file-custody",
        )?;
        Ok(v)
    }
    pub(super) fn read(
        &mut self,
        parent: usize,
        name: &str,
        limit: usize,
        private: bool,
    ) -> Result<Vec<u8>> {
        need(super::input::component(name), "file-component")?;
        self.current()?;
        let file = openat(
            self.file(parent)?,
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|e| Failure::new("file-open", e))?;
        let id = self.add(file, Place::Child(parent, name.into()))?;
        let result = (|| {
            let before = self.regular(id, private)?;
            need(before.bytes as u64 <= limit as u64, "file-read-bound")?;
            let mut bytes = vec![];
            self.file(id)?
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| Failure::new("file-read", e))?;
            need(
                bytes.len() <= limit && self.stamp(id)? == before,
                "file-read-currency",
            )?;
            self.held[id].observed = Some(before);
            self.current()?;
            Ok(bytes)
        })();
        self.retain_read(id, result)
    }
    pub(super) fn file_identity(&mut self, parent: usize, name: &str) -> Result<Identity> {
        need(super::input::component(name), "file-component")?;
        self.current()?;
        let file = openat(
            self.file(parent)?,
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|e| Failure::new("identity-open", e))?;
        let id = self.add(file, Place::Child(parent, name.into()))?;
        let result = self
            .regular(id, false)
            .and_then(|v| self.current().map(|()| v.identity));
        let result = result.and_then(|value| {
            self.held[id].observed = Some(self.stamp(id)?);
            self.current()?;
            Ok(value)
        });
        self.retain_read(id, result)
    }
    pub(super) fn hash_file(&mut self, parent: usize, name: &str, limit: u64) -> Result<String> {
        need(super::input::component(name), "file-component")?;
        self.current()?;
        let file = openat(
            self.file(parent)?,
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|e| Failure::new("hash-open", e))?;
        let id = self.add(file, Place::Child(parent, name.into()))?;
        let result = self.regular(id, false).and_then(|before| {
            self.hash_contents(id, limit).and_then(|value| {
                need(self.stamp(id)? == before, "hash-retain-currency")?;
                self.held[id].observed = Some(before);
                self.current()?;
                Ok(value)
            })
        });
        self.retain_read(id, result)
    }
    fn hash_contents(&self, id: usize, limit: u64) -> Result<String> {
        let before = self.regular(id, false)?;
        need(before.bytes as u64 <= limit, "hash-bound")?;
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 65536];
        let mut total = 0_u64;
        let mut reader = self.file(id)?;
        loop {
            self.deadline()?;
            let count = reader
                .read(&mut buffer)
                .map_err(|e| Failure::new("hash-read", e))?;
            if count == 0 {
                break;
            }
            total += count as u64;
            need(total <= limit, "hash-growth")?;
            hash.update(&buffer[..count]);
        }
        need(
            total == before.bytes as u64 && self.stamp(id)? == before,
            "hash-currency",
        )?;
        self.current()?;
        Ok(format!("{:x}", hash.finalize()))
    }
    fn retain_read<T>(&mut self, id: usize, result: Result<T>) -> Result<T> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let closed = self.close_one(id);
                join(Err(error), closed)
            }
        }
    }
    pub(super) fn seal_directory(&mut self, id: usize) -> Result<()> {
        self.current()?;
        self.held[id].observed = Some(self.stamp(id)?);
        self.current()
    }
    pub(super) fn write_new(&mut self, parent: usize, name: &str, bytes: &[u8]) -> Result<()> {
        need(super::input::component(name), "file-component")?;
        self.current()?;
        let file = openat(
            self.file(parent)?,
            name,
            OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map(File::from)
        .map_err(|e| Failure::new("file-create", e))?;
        let id = self.add(file, Place::Child(parent, name.into()))?;
        let result = (|| {
            let mut file = self.file(id)?;
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|e| Failure::new("file-write-sync", e))?;
            self.regular(id, true)?;
            self.current()
        })();
        let closed = self.close_one(id);
        join(result, closed)?;
        self.sync(parent)?;
        need(
            self.read(parent, name, bytes.len(), true)? == bytes,
            "file-write-readback",
        )
    }
    pub(super) fn link(&mut self, parent: usize, name: &str, target: &Path) -> Result<()> {
        need(super::input::component(name), "link-component")?;
        self.current()?;
        symlinkat(target, self.file(parent)?, name).map_err(|e| Failure::new("context-link", e))?;
        self.sync(parent)?;
        self.link_matches(parent, name, target)
    }
    pub(super) fn link_matches(&mut self, parent: usize, name: &str, target: &Path) -> Result<()> {
        need(super::input::component(name), "link-component")?;
        self.current()?;
        let file = openat(
            self.file(parent)?,
            name,
            OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|e| Failure::new("link-open", e))?;
        let id = self.add(file, Place::Child(parent, name.into()))?;
        let identity = self.identity(id)?;
        need(
            SFlag::from_bits_truncate(identity.mode) == SFlag::S_IFLNK
                && identity.uid == geteuid().as_raw(),
            "link-custody",
        )?;
        let actual = readlinkat(self.file(parent)?, name)
            .map_err(|e| Failure::new("context-link-read", e))?;
        need(
            actual.as_encoded_bytes() == target.as_os_str().as_encoded_bytes(),
            "context-link-currency",
        )?;
        self.current()
    }
    pub(super) fn publish_directory(
        &mut self,
        parent: usize,
        pending: &str,
        final_name: &str,
        id: usize,
    ) -> Result<()> {
        need(
            super::input::component(pending) && super::input::component(final_name),
            "generation-component",
        )?;
        self.current()?;
        rustix::fs::renameat_with(
            self.file(parent)?,
            pending,
            self.file(parent)?,
            final_name,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(|e| Failure::new("generation-publication", e))?;
        self.held[id].place = Place::Child(parent, final_name.into());
        self.sync(parent)?;
        self.current()
    }
    pub(super) fn names(&mut self, parent: usize) -> Result<Vec<String>> {
        self.current()?;
        let file = openat(self.file(parent)?, ".", DIR, Mode::empty())
            .map(File::from)
            .map_err(|e| Failure::new("inventory-open", e))?;
        let cursor = self.add(file, Place::Alias(parent))?;
        let before = self.stamp(parent)?;
        let result = self.read_names(cursor).and_then(|names| {
            need(self.stamp(parent)? == before, "inventory-currency")?;
            self.held[parent].observed = Some(before);
            self.current()?;
            Ok(names)
        });
        let closed = self.close_one(cursor);
        join(result, closed)
    }
    fn read_names(&self, cursor: usize) -> Result<Vec<String>> {
        let mut buffer = [MaybeUninit::uninit(); 8192];
        let mut raw = rustix::fs::RawDir::new(self.file(cursor)?, &mut buffer);
        let mut names = vec![];
        let mut seen = 0;
        while let Some(entry) = raw.next() {
            self.deadline()?;
            seen += 1;
            need(seen <= 130, "inventory-bound")?;
            let entry = entry.map_err(|e| Failure::new("inventory-read", e))?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|e| Failure::new("inventory-name", e))?;
            if matches!(name, "." | "..") {
                continue;
            }
            need(super::input::component(name), "inventory-component")?;
            names.push(name.to_owned());
        }
        names.sort();
        need(
            !names.windows(2).any(|v| v[0] == v[1]),
            "inventory-duplicate",
        )?;
        self.current()?;
        Ok(names)
    }
    pub(super) fn new_child(&mut self, parent: usize, name: &str) -> Result<usize> {
        need(super::input::component(name), "directory-component")?;
        self.current()?;
        mkdirat(self.file(parent)?, name, Mode::from_bits_truncate(0o700))
            .map_err(|e| Failure::new("directory-exclusive", e))?;
        self.sync(parent)?;
        self.child(parent, name, false, true)
    }
    pub(super) fn copy_file(
        &mut self,
        source: usize,
        target: usize,
        name: &str,
        remaining: &mut u64,
    ) -> Result<String> {
        need(super::input::component(name), "copy-component")?;
        self.current()?;
        let file = openat(
            self.file(source)?,
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|e| Failure::new("copy-source-open", e))?;
        let input = self.add(file, Place::Child(source, name.into()))?;
        let result = (|| {
            let before = self.regular(input, false)?;
            let size = u64::try_from(before.bytes).map_err(|e| Failure::new("copy-size", e))?;
            need(size <= *remaining, "context-byte-bound")?;
            let output = openat(
                self.file(target)?,
                name,
                OFlag::O_WRONLY
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map(File::from)
            .map_err(|e| Failure::new("copy-target-open", e))?;
            let output = self.add(output, Place::Child(target, name.into()))?;
            let copied = self.transfer(input, output, size);
            let closed = self.close_one(output);
            let digest = join(copied, closed)?;
            need(self.stamp(input)? == before, "copy-source-currency")?;
            self.current()?;
            need(
                self.hash_file(target, name, size)? == digest,
                "copy-readback",
            )?;
            *remaining -= size;
            Ok(digest)
        })();
        let closed = self.close_one(input);
        join(result, closed)
    }
    fn transfer(&self, input: usize, output: usize, size: u64) -> Result<String> {
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 65536];
        let mut total = 0_u64;
        loop {
            self.deadline()?;
            let count = self
                .file(input)?
                .read(&mut buffer)
                .map_err(|e| Failure::new("copy-read", e))?;
            if count == 0 {
                break;
            }
            total += count as u64;
            need(total <= size, "copy-growth")?;
            self.file(output)?
                .write_all(&buffer[..count])
                .map_err(|e| Failure::new("copy-write", e))?;
            hash.update(&buffer[..count]);
        }
        need(total == size, "copy-short-read")?;
        self.file(output)?
            .sync_all()
            .map_err(|e| Failure::new("copy-sync", e))?;
        Ok(format!("{:x}", hash.finalize()))
    }
    pub(super) fn close_one(&mut self, id: usize) -> Result<()> {
        let file = self
            .held
            .get_mut(id)
            .and_then(|v| v.file.take())
            .ok_or_else(|| Failure::refused("close-owner"))?;
        let result = close(file).map_err(|e| Failure::new("file-close", e));
        #[cfg(test)]
        {
            self.close_calls += 1;
            if self.lose_close == Some(id) {
                return join(result, Err(Failure::refused("close-ack-unknown")));
            }
        }
        result
    }
    pub(super) fn close_all(&mut self) -> Result<()> {
        let mut result = Ok(());
        for id in (0..self.held.len()).rev() {
            if self.held[id].file.is_some() {
                result = join(result, self.close_one(id));
            }
        }
        result
    }
}

#[cfg(test)]
mod tests;
