//! Iterative, names/metadata-only inventory and checked postorder deletion.
//! The same accepted directory identities are re-opened before every operation.
use super::*;
use std::{collections::BTreeMap, ffi::OsStr};
type Parts = Vec<OsString>;
struct Entry {
    parts: Parts,
    stamp: Stamp,
}
impl Entry {
    fn current(&self, actual: &Stamp) -> bool {
        if self.stamp.directory() {
            self.stamp.same_directory(actual)
        } else {
            self.stamp == *actual
        }
    }
}
enum Task {
    Directory(Parts),
    Named(Parts),
    Entry(Parts, Stamp),
}
pub(super) struct Tree {
    entries: Vec<Entry>,
    directories: BTreeMap<Parts, Stamp>,
    keys: BTreeSet<Key>,
    mount: reverie_core::decimal::UnsignedInteger,
    bytes: u64,
}
impl Tree {
    pub(super) fn scan(root: &File, uid: u32, end: Instant) -> Result<Self> {
        check(end)?;
        let stamp = Stamp::capture(&root.metadata()?);
        need(
            stamp.directory() && stamp.uid == uid && stamp.mode & 0o7777 == 0o700,
            StorageFault::ColdTree,
        )?;
        let mut tree = Self {
            entries: Vec::new(),
            directories: BTreeMap::from([(Vec::new(), stamp.clone())]),
            keys: BTreeSet::from([stamp.key]),
            mount: mount(root)?,
            bytes: 0,
        };
        let mut pending = vec![Task::Directory(Vec::new())];
        let mut count = 0;
        while let Some(task) = pending.pop() {
            check(end)?;
            match task {
                Task::Entry(parts, stamp) => tree.entries.push(Entry { parts, stamp }),
                Task::Named(parts) => tree.visit(root, parts, uid, end, &mut pending)?,
                Task::Directory(parts) => {
                    tree.directory(root, parts, end, &mut count, &mut pending)?
                }
            }
        }
        Ok(tree)
    }
    fn directory(
        &mut self,
        root: &File,
        parts: Parts,
        end: Instant,
        count: &mut usize,
        pending: &mut Vec<Task>,
    ) -> Result<()> {
        let directory = self.parent(root, &parts, end)?;
        let result = (|| {
            if !parts.is_empty() {
                need(
                    Stamp::capture(&directory.metadata()?) == self.directories[&parts],
                    StorageFault::ColdTree,
                )?;
            }
            let found = names(&directory, MAX_ENTRIES - *count, end)?;
            *count += found.len();
            for name in found.into_iter().rev() {
                let mut selected = parts.clone();
                selected.push(name);
                pending.push(Task::Named(selected));
            }
            Ok(())
        })();
        finalized(result, fs::close(directory))
    }
    fn visit(
        &mut self,
        root: &File,
        parts: Parts,
        uid: u32,
        end: Instant,
        pending: &mut Vec<Task>,
    ) -> Result<()> {
        check(end)?;
        let (name, parents) = parts.split_last().expect("named entry");
        need(
            ![".keep", ".reverie-task.json", ".git", ".hg", ".svn"]
                .iter()
                .any(|value| name == OsStr::new(value)),
            StorageFault::ColdPreservation,
        )?;
        let parent = self.parent(root, parents, end)?;
        let opened = native::open_at(parent.as_raw_fd(), name, libc::O_PATH).map_err(Into::into);
        let entry = match (opened, fs::close(parent)) {
            (Ok(file), Ok(())) => file,
            (Err(error), closed) => return finalized(Err(error), closed),
            (Ok(file), Err(error)) => return finalized(Err(error), fs::close(file)),
        };
        let result = (|| {
            let stamp = Stamp::capture(&entry.metadata()?);
            need(
                stamp.uid == uid && stamp.key.0 == self.directories[&Vec::new()].key.0,
                StorageFault::ColdTree,
            )?;
            need(mount(&entry)? == self.mount, StorageFault::ColdMount)?;
            let kind = stamp.mode & libc::S_IFMT;
            need(
                [libc::S_IFDIR, libc::S_IFREG, libc::S_IFLNK].contains(&kind),
                StorageFault::ColdTree,
            )?;
            need(
                kind != libc::S_IFREG || stamp.links == 1,
                StorageFault::ColdTree,
            )?;
            Ok(stamp)
        })();
        let stamp = finalized(result, fs::close(entry))?;
        self.bytes = self
            .bytes
            .checked_add(stamp.size)
            .ok_or(StorageError::Refused(StorageFault::ColdBound))?;
        need(self.bytes <= MAX_BYTES, StorageFault::ColdBound)?;
        self.keys.insert(stamp.key);
        pending.push(Task::Entry(parts.clone(), stamp.clone()));
        if stamp.directory() {
            self.directories.insert(parts.clone(), stamp);
            pending.push(Task::Directory(parts));
        }
        Ok(())
    }
    fn parent(&self, root: &File, parts: &[OsString], end: Instant) -> Result<File> {
        let mut current = native::open_at(
            root.as_raw_fd(),
            OsStr::new("."),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let result = (|| {
            let mut selected = Vec::new();
            self.current(&current, &selected, end)?;
            for name in parts {
                selected.push(name.clone());
                let next = native::open_at(
                    current.as_raw_fd(),
                    name,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                )?;
                // Always consume/adopt next before any checked finalizer can
                // fail; neither actual descriptor is lost on the error path.
                let previous = std::mem::replace(&mut current, next);
                fs::close(previous)?;
                self.current(&current, &selected, end)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => Ok(current),
            Err(error) => finalized(Err(error), fs::close(current)),
        }
    }
    fn current(&self, file: &File, parts: &Parts, end: Instant) -> Result<()> {
        check(end)?;
        let stamp = Stamp::capture(&file.metadata()?);
        need(
            self.directories
                .get(parts)
                .is_some_and(|expected| expected.same_directory(&stamp)),
            StorageFault::ColdTree,
        )?;
        need(mount(file)? == self.mount, StorageFault::ColdMount)
    }
    pub(super) fn keys(&self) -> &BTreeSet<Key> {
        &self.keys
    }
    pub(super) fn directory_keys(&self) -> BTreeSet<Key> {
        self.directories.values().map(|stamp| stamp.key).collect()
    }
    pub(super) fn count(&self) -> usize {
        self.entries.len()
    }
    pub(super) fn remove_entry(&self, index: usize, root: &File, end: Instant) -> Result<()> {
        let entry = &self.entries[index];
        check(end)?;
        let (name, parents) = entry.parts.split_last().expect("nonempty cold entry");
        let parent = self.parent(root, parents, end)?;
        let result = (|| {
            let held = native::open_at(parent.as_raw_fd(), name, libc::O_PATH)?;
            let checked = (|| {
                let actual = Stamp::capture(&held.metadata()?);
                need(entry.current(&actual), StorageFault::ColdTree)?;
                need(mount(&held)? == self.mount, StorageFault::ColdMount)
            })();
            finalized(checked, fs::close(held))?;
            let flags = if entry.stamp.directory() {
                nix::unistd::UnlinkatFlags::RemoveDir
            } else {
                nix::unistd::UnlinkatFlags::NoRemoveDir
            };
            nix::unistd::unlinkat(&parent, name.as_os_str(), flags)
                .map_err(std::io::Error::from)?;
            Ok(())
        })();
        finalized(result, fs::close(parent))
    }
    pub(super) fn finish_removal(&self, root: &File, end: Instant) -> Result<()> {
        self.current(root, &Vec::new(), end)?;
        need(names(root, 0, end)?.is_empty(), StorageFault::ColdTree)?;
        root.sync_all()?;
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn remove(&self, root: &File, end: Instant) -> Result<()> {
        for index in 0..self.count() {
            self.remove_entry(index, root, end)?;
        }
        self.finish_removal(root, end)
    }
}
