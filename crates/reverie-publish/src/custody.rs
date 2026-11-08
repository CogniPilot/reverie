//! Held directories. A directory is opened one component at a time from `/`, each with
//! `O_NOFOLLOW | O_DIRECTORY`, and the final descriptor is kept: a symlink anywhere on the path,
//! the directory itself included, is refused, and once it is held a rename or swap of any ancestor
//! cannot change what is read or written under it. Everything below a held directory is reached
//! through that descriptor with `openat`, never by path again.
use nix::{
    dir::{Dir, Type},
    errno::Errno,
    fcntl::{AtFlags, OFlag, openat},
    sys::stat::{FileStat, Mode, SFlag, fstat, fstatat, mkdirat},
    unistd::{UnlinkatFlags, fsync, unlinkat},
};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, OwnedFd},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const DIRECTORY: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);

#[derive(Debug)]
pub struct Held {
    fd: OwnedFd,
    path: PathBuf,
}

impl Held {
    /// Opens `path` (relative paths start at the current directory) refusing a symlink in any
    /// component, and a `..`.
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::walk_from_root(path, false)
    }

    /// Like `open`, but a missing component is created (mode 0700) inside its already-held
    /// parent with `mkdirat` and then opened no-follow, so nothing is ever created through a
    /// symlink.
    pub fn open_or_create(path: &Path) -> Result<Self, String> {
        Self::walk_from_root(path, true)
    }

    fn walk_from_root(path: &Path, create: bool) -> Result<Self, String> {
        let shown = path.display();
        let absolute = std::path::absolute(path).map_err(|e| format!("{shown}: {e}"))?;
        let mut fd = nix::fcntl::open("/", DIRECTORY, Mode::empty())
            .map_err(|e| format!("{shown}: /: {e}"))?;
        for component in absolute.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(part) => {
                    fd = step(&fd, part, create).map_err(|e| format!("{shown}: {e}"))?;
                }
                Component::ParentDir | Component::Prefix(_) => {
                    return Err(format!("{shown}: a path with .. is refused"));
                }
            }
        }
        Ok(Self {
            fd,
            path: path.to_path_buf(),
        })
    }

    /// The path this was opened from, for messages only.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A path to the held directory itself that a child process can use as its working
    /// directory: `/proc/self/fd/N` names this descriptor, which the child inherits until it
    /// executes, so the child starts inside the held directory whatever its path now names.
    pub fn proc_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.fd.as_raw_fd()))
    }

    /// Opens `name` (`/`-separated, relative) below this directory with every component
    /// no-follow; `what` names the place in messages.
    fn walk(&self, name: &str, what: &str) -> Result<(OwnedFd, String), String> {
        let parts: Vec<&str> = name.split('/').collect();
        if parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == "..")
        {
            return Err(format!("{name}: unsafe path"));
        }
        let (leaf, dirs) = parts.split_last().ok_or_else(|| format!("{name}: empty"))?;
        let mut fd =
            openat(&self.fd, ".", DIRECTORY, Mode::empty()).map_err(|e| format!("{name}: {e}"))?;
        for part in dirs {
            fd = openat(&fd, *part, DIRECTORY, Mode::empty())
                .map_err(|e| refusal(&fd, part, name, what, e))?;
        }
        Ok((fd, (*leaf).to_owned()))
    }

    /// Reads a regular file below this directory; a symlink in any component, or anything but a
    /// regular file at the end, is refused.
    pub fn read_regular(&self, name: &str, what: &str) -> Result<Vec<u8>, String> {
        let (parent, leaf) = self.walk(name, what)?;
        let flags = OFlag::O_RDONLY
            | OFlag::O_NOFOLLOW
            | OFlag::O_NONBLOCK
            | OFlag::O_NOCTTY
            | OFlag::O_CLOEXEC;
        let fd = openat(&parent, leaf.as_str(), flags, Mode::empty())
            .map_err(|e| refusal(&parent, &leaf, name, what, e))?;
        let stat = fstat(&fd).map_err(|e| format!("{name}: {e}"))?;
        if !is_type(&stat, SFlag::S_IFREG) {
            return Err(format!("{name}: only regular files are read from {what}"));
        }
        let mut bytes = Vec::new();
        File::from(fd)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("{name}: {e}"))?;
        Ok(bytes)
    }

    /// Every entry below this directory that is not itself a directory, as `/`-separated paths;
    /// subdirectories are entered no-follow, and a symlink is listed (never entered).
    pub fn files(&self) -> Result<BTreeSet<String>, String> {
        let mut out = BTreeSet::new();
        let fd = openat(&self.fd, ".", DIRECTORY, Mode::empty())
            .map_err(|e| format!("{}: {e}", self.path.display()))?;
        list(fd, "", &mut out).map_err(|e| format!("{}: {e}", self.path.display()))?;
        Ok(out)
    }

    /// Creates `name` in this directory with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600: an
    /// existing entry of any kind (a file, a hardlink, a symlink, even a dangling one) refuses, so
    /// nothing already there is followed, truncated or overwritten.
    fn create(&self, name: &str) -> Result<(File, (u64, u64)), String> {
        if name.is_empty() || name.contains('/') || name == "." || name == ".." {
            return Err(format!("{name}: not a plain file name"));
        }
        let flags =
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let fd = openat(&self.fd, name, flags, Mode::from_bits_truncate(0o600))
            .map_err(|e| format!("{}/{name}: {e}", self.path.display()))?;
        let stat = fstat(&fd).map_err(|e| format!("{name}: {e}"))?;
        Ok((File::from(fd), (stat.st_dev, stat.st_ino)))
    }

    /// `create`s `name` and writes `bytes` as a temporary file, removed when the result drops.
    pub fn create_new(&self, name: &str, bytes: &[u8]) -> Result<Owned<'_>, String> {
        let (file, identity) = self.create(name)?;
        let mut owned = Owned {
            dir: self,
            name: name.to_owned(),
            identity,
            file,
        };
        owned
            .file
            .write_all(bytes)
            .map_err(|e| format!("{name}: {e}"))?;
        Ok(owned)
    }

    /// `create`s `name` and writes `bytes` durably, as a record that stays: the file is synced,
    /// then the held directory, so the new entry itself survives a crash too.
    pub fn write_new(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let (mut file, _) = self.create(name)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("{name}: {e}"))?;
        fsync(&self.fd).map_err(|e| format!("{}: {e}", self.path.display()))
    }

    /// `create_new` under a name no other process or call uses: `<stem>-<pid>-<time>-<n>.<ext>`,
    /// retried under a fresh name if one somehow exists.
    pub fn create_unique(&self, stem: &str, ext: &str, bytes: &[u8]) -> Result<Owned<'_>, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let mut last = String::new();
        for _ in 0..8 {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let name = format!("{stem}-{}-{nanos:x}-{n}.{ext}", std::process::id());
            match self.create_new(&name, bytes) {
                Ok(owned) => return Ok(owned),
                Err(e) if e.ends_with(Errno::EEXIST.desc()) => last = e,
                Err(e) => return Err(e),
            }
        }
        Err(last)
    }
}

/// A file this process created in a held directory. Dropping it removes it, but only while the
/// name still holds the very file created: anything put in its place is left alone. The file
/// stays open until then, so its inode cannot be freed and reused by a replacement.
#[derive(Debug)]
pub struct Owned<'h> {
    dir: &'h Held,
    name: String,
    identity: (u64, u64),
    file: File,
}

impl Owned<'_> {
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for Owned<'_> {
    fn drop(&mut self) {
        let same = fstatat(
            &self.dir.fd,
            self.name.as_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .is_ok_and(|s| (s.st_dev, s.st_ino) == self.identity);
        if same {
            let _ = unlinkat(&self.dir.fd, self.name.as_str(), UnlinkatFlags::NoRemoveDir);
        }
    }
}

/// Opens the directory `part` inside `dir` no-follow, first making it (mode 0700) when `create`
/// and nothing is there yet.
fn step(dir: &OwnedFd, part: &std::ffi::OsStr, create: bool) -> Result<OwnedFd, String> {
    let name = part.to_string_lossy();
    if create {
        make_dir(dir, part).map_err(|e| format!("{name}: {e}"))?;
    }
    openat(dir, part, DIRECTORY, Mode::empty()).map_err(|e| match e {
        Errno::ELOOP | Errno::ENOTDIR if is_symlink(dir, part) => {
            format!("{name} is a symlink; the path must not pass through one")
        }
        e => format!("{name}: {e}"),
    })
}

/// Makes `part` inside `dir` (mode 0700) unless something is already there.
fn make_dir(dir: &OwnedFd, part: &std::ffi::OsStr) -> nix::Result<()> {
    match mkdirat(dir, part, Mode::from_bits_truncate(0o700)) {
        Ok(()) | Err(Errno::EEXIST) => Ok(()),
        Err(e) => Err(e),
    }
}

fn is_type(stat: &FileStat, kind: SFlag) -> bool {
    SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT == kind
}

fn is_symlink<P: ?Sized + nix::NixPath>(dir: &OwnedFd, name: &P) -> bool {
    fstatat(dir, name, AtFlags::AT_SYMLINK_NOFOLLOW).is_ok_and(|s| is_type(&s, SFlag::S_IFLNK))
}

fn refusal(dir: &OwnedFd, part: &str, name: &str, what: &str, e: Errno) -> String {
    if matches!(e, Errno::ELOOP | Errno::ENOTDIR) && is_symlink(dir, part) {
        format!("{name}: a symlink in {what} is refused")
    } else {
        format!("{name}: {e}")
    }
}

/// Lists through its own descriptor (`Dir` consumes one) and stats and enters subdirectories
/// through `fd`, both the same held directory.
fn list(fd: OwnedFd, prefix: &str, out: &mut BTreeSet<String>) -> nix::Result<()> {
    let mut dir = Dir::from_fd(openat(&fd, ".", DIRECTORY, Mode::empty())?)?;
    for entry in dir.iter() {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let directory = match entry.file_type() {
            Some(kind) => kind == Type::Directory,
            None => is_type(
                &fstatat(&fd, entry.file_name(), AtFlags::AT_SYMLINK_NOFOLLOW)?,
                SFlag::S_IFDIR,
            ),
        };
        let path = format!("{prefix}{name}");
        if directory {
            let sub = openat(&fd, entry.file_name(), DIRECTORY, Mode::empty())?;
            list(sub, &format!("{path}/"), out)?;
        } else {
            out.insert(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("publish-held-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_symlink_at_or_above_the_directory_is_refused() {
        let root = scratch("ancestry");
        fs::create_dir_all(root.join("real/packet")).unwrap();
        symlink(root.join("real/packet"), root.join("alias")).unwrap();
        symlink(root.join("real"), root.join("up")).unwrap();
        for path in [root.join("alias"), root.join("up/packet")] {
            let error = Held::open(&path).unwrap_err();
            assert!(error.contains("is a symlink"), "{error}");
        }
        assert!(Held::open(&root.join("real/../real/packet")).is_err());
        assert!(Held::open(&root.join("real/packet")).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_directories_are_created_only_inside_held_parents() {
        let root = scratch("create-dirs");
        fs::create_dir_all(root.join("outside")).unwrap();
        symlink(root.join("outside"), root.join("alias")).unwrap();
        let error = Held::open_or_create(&root.join("alias/records/new")).unwrap_err();
        assert!(error.contains("is a symlink"), "{error}");
        assert!(!root.join("outside/records").exists());
        let held = Held::open_or_create(&root.join("real/records/new")).unwrap();
        assert!(root.join("real/records/new").is_dir());
        drop(held);
        assert!(Held::open_or_create(&root.join("real/records/new")).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_held_directory_keeps_reading_what_it_opened_after_its_parents_are_swapped() {
        let root = scratch("swap");
        fs::create_dir_all(root.join("a/packet")).unwrap();
        fs::write(root.join("a/packet/BODY.md"), "reviewed\n").unwrap();
        let held = Held::open(&root.join("a/packet")).unwrap();
        // Swap the parent for a symlink to a look-alike holding other bytes.
        fs::rename(root.join("a"), root.join("a-moved")).unwrap();
        fs::create_dir_all(root.join("decoy/packet")).unwrap();
        fs::write(root.join("decoy/packet/BODY.md"), "substituted\n").unwrap();
        symlink(root.join("decoy"), root.join("a")).unwrap();
        assert_eq!(
            held.read_regular("BODY.md", "the packet").unwrap(),
            b"reviewed\n"
        );
        // A subdirectory swapped for a symlink below the held directory is refused.
        fs::create_dir_all(root.join("a-moved/packet/sub")).unwrap();
        fs::write(root.join("a-moved/packet/sub/n.txt"), "x").unwrap();
        assert_eq!(held.read_regular("sub/n.txt", "the packet").unwrap(), b"x");
        fs::rename(root.join("a-moved/packet/sub"), root.join("sub-moved")).unwrap();
        symlink(root.join("sub-moved"), root.join("a-moved/packet/sub")).unwrap();
        let error = held.read_regular("sub/n.txt", "the packet").unwrap_err();
        assert!(
            error.contains("a symlink in the packet is refused"),
            "{error}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_new_never_follows_truncates_or_overwrites_an_existing_entry() {
        let root = scratch("create");
        fs::create_dir_all(root.join("store")).unwrap();
        fs::write(root.join("canary"), "outside\n").unwrap();
        let store = Held::open(&root.join("store")).unwrap();
        symlink(root.join("canary"), root.join("store/link")).unwrap();
        symlink(root.join("missing"), root.join("store/dangling")).unwrap();
        fs::write(root.join("store/file"), "kept\n").unwrap();
        fs::hard_link(root.join("canary"), root.join("store/hard")).unwrap();
        for name in ["link", "dangling", "file", "hard"] {
            let error = store.create_new(name, b"bundle bytes").unwrap_err();
            assert!(error.ends_with(Errno::EEXIST.desc()), "{name}: {error}");
        }
        assert_eq!(fs::read(root.join("canary")).unwrap(), b"outside\n");
        assert_eq!(fs::read(root.join("store/file")).unwrap(), b"kept\n");
        assert!(!root.join("missing").exists());
        {
            let one = store.create_unique("copy", "bundle", b"one").unwrap();
            let two = store.create_unique("copy", "bundle", b"two").unwrap();
            assert_ne!(one.name(), two.name());
            assert_eq!(
                fs::read(root.join("store").join(one.name())).unwrap(),
                b"one"
            );
            // A replacement at an owned name is not removed on drop.
            fs::remove_file(root.join("store").join(two.name())).unwrap();
            fs::write(root.join("store").join(two.name()), "replaced").unwrap();
        }
        let left: Vec<_> = fs::read_dir(root.join("store"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("copy-"))
            .collect();
        assert_eq!(left.len(), 1, "{left:?}");
        assert_eq!(
            fs::read(root.join("store").join(&left[0])).unwrap(),
            b"replaced"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
