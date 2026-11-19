//! Snapshot the same profile and GC-root scopes through pinned directories.
use super::Result;
use crate::native::{self, EntryStat};
use reverie_contracts::worker_nix::offline_qualification::{ProfileEntry, ProfileInventory};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, Metadata},
    io,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Component, Path},
};

const DIRECTORY: i32 = libc::O_RDONLY | libc::O_DIRECTORY;

#[cfg(test)]
pub(super) fn inventory(home: &[u32], nix: &[u32], entries: usize) -> Result<Vec<u8>> {
    let home = native::python_path(home)?;
    let nix = native::python_path(nix)?;
    Ok(collect(&home, &nix, entries)?.bytes()?)
}

pub(super) fn collect(home: &Path, nix: &Path, entries: usize) -> Result<ProfileInventory> {
    let uid = ::nix::unistd::getuid().as_raw();
    let mut inventory = ProfileInventory::new(entries)?;
    for (root, prefix, relative) in [
        (nix, "nix", "var/nix/profiles"),
        (nix, "nix", "var/nix/gcroots"),
        (home, "home", ".nix-profile"),
        (home, "home", ".local/state/nix/profiles"),
    ] {
        let ancestors = Ancestors::open(root)?;
        let mut tree = Tree {
            uid,
            entries: &mut inventory,
            device: ancestors.last().metadata()?.dev(),
        };
        let key = native::python_text(Path::new(&format!("{prefix}:{relative}")));
        tree.scope(ancestors, Path::new(relative), key)?;
    }
    Ok(inventory)
}

struct Ancestors {
    root: File,
    entries: Vec<(OsString, File)>,
}

impl Ancestors {
    fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .collect::<std::path::PathBuf>()
                .as_os_str()
                != path.as_os_str()
        {
            return Err("canonical profile path required".into());
        }
        let mut result = Self {
            root: native::open_at(libc::AT_FDCWD, OsStr::new("/"), DIRECTORY)?,
            entries: Vec::new(),
        };
        result.descend(path.strip_prefix("/")?)?;
        result.confirm()?;
        Ok(result)
    }

    fn descend(&mut self, path: &Path) -> Result<()> {
        for part in path.components() {
            let Component::Normal(part) = part else {
                return Err("canonical profile path required".into());
            };
            let directory = native::open_at(self.last().as_raw_fd(), part, DIRECTORY)?;
            self.entries.push((part.to_owned(), directory));
        }
        Ok(())
    }

    fn last(&self) -> &File {
        self.entries.last().map_or(&self.root, |pair| &pair.1)
    }

    fn confirm(&self) -> Result<()> {
        let mut parent = &self.root;
        for (name, child) in &self.entries {
            let held = child.metadata()?;
            let named = native::entry_stat(parent, name)?;
            if identity(&named) != file_identity(&held) {
                return Err("profile directory chain changed".into());
            }
            parent = child;
        }
        Ok(())
    }
}

struct Tree<'a> {
    uid: u32,
    device: u64,
    entries: &'a mut ProfileInventory,
}

impl Tree<'_> {
    fn scope(&mut self, mut parent: Ancestors, path: &Path, key: Vec<u32>) -> Result<()> {
        match parent.descend(path.parent().ok_or("profile parent unavailable")?) {
            Ok(()) => (),
            Err(error) if absent(error.as_ref()) => {
                parent.confirm()?;
                return self.absent(key);
            }
            Err(error) => return Err(error),
        }
        let name = path.file_name().ok_or("profile name unavailable")?;
        let before = match native::entry_stat(parent.last(), name) {
            Ok(before) => before,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                parent.confirm()?;
                return self.absent(key);
            }
            Err(error) => return Err(error.into()),
        };
        self.visit(parent.last(), name, key, before, 0)?;
        parent.confirm()
    }

    fn absent(&mut self, key: Vec<u32>) -> Result<()> {
        self.entries.record(key, ProfileEntry::Absent)?;
        Ok(())
    }

    fn visit(
        &mut self,
        parent: &File,
        name: &OsStr,
        key: Vec<u32>,
        before: EntryStat,
        depth: usize,
    ) -> Result<()> {
        if depth > 24 {
            return Err("profile inventory bound".into());
        }
        if before.device != self.device || before.uid != self.uid {
            return Err("profile ownership/device changed".into());
        }
        let id = identity(&before);
        let directory = before.mode & libc::S_IFMT == libc::S_IFDIR;
        let entry = match before.mode & libc::S_IFMT {
            libc::S_IFDIR => ProfileEntry::Directory(id),
            libc::S_IFREG => ProfileEntry::File(id),
            libc::S_IFLNK => {
                let target = ::nix::fcntl::readlinkat(parent, name)?;
                ProfileEntry::Link(id, native::python_text(Path::new(&target)))
            }
            _ => return Err("unsupported profile object".into()),
        };
        self.entries.record(key.clone(), entry)?;
        if directory {
            self.directory(parent, name, &key, &before, depth)?;
        }
        let after = native::entry_stat(parent, name)?;
        if identity(&after) != id || times(&after) != times(&before) {
            return Err("profile metadata changed".into());
        }
        Ok(())
    }

    fn directory(
        &mut self,
        parent: &File,
        name: &OsStr,
        key: &[u32],
        before: &EntryStat,
        depth: usize,
    ) -> Result<()> {
        let opened = native::open_at(parent.as_raw_fd(), name, DIRECTORY)?;
        if file_identity(&opened.metadata()?) != identity(before) {
            return Err("profile directory replaced".into());
        }
        // The live File holds this procfs descriptor path for the full walk.
        // Entries are opened relative to that File, never via returned paths.
        let listing = format!("/proc/self/fd/{}", opened.as_raw_fd());
        for entry in fs::read_dir(listing)? {
            let name = entry?.file_name();
            let mut child = key.to_vec();
            child.push(u32::from('/'));
            child.extend(native::python_text(Path::new(&name)));
            let before = native::entry_stat(&opened, &name)?;
            self.visit(&opened, &name, child, before, depth + 1)?;
        }
        let after = opened.metadata()?;
        if (
            (after.mtime(), after.mtime_nsec()),
            (after.ctime(), after.ctime_nsec()),
        ) != times(before)
        {
            return Err("profile listing changed".into());
        }
        Ok(())
    }
}

fn absent(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
}
fn identity(value: &EntryStat) -> [u64; 4] {
    [
        value.device,
        value.inode,
        u64::from(value.uid),
        u64::from(value.mode & 0o7777),
    ]
}
fn file_identity(value: &Metadata) -> [u64; 4] {
    [
        value.dev(),
        value.ino(),
        u64::from(value.uid()),
        u64::from(value.mode() & 0o7777),
    ]
}
fn times(value: &EntryStat) -> ((i64, i64), (i64, i64)) {
    (value.mtime, value.ctime)
}
