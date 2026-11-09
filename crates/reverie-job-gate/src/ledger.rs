//! Private descriptor-anchored ledger. Every operation requires this exact
//! ledger's actual flock; unknown entries and incomplete publications stay put.
use crate::{
    GateError,
    facts::{Process, process},
};
use nix::{
    fcntl::{AtFlags, Flock, FlockArg, OFlag, open, openat, renameat},
    sys::stat::{FileStat, Mode, SFlag, fstat, fstatat, lstat},
    unistd::{UnlinkatFlags, close, geteuid, unlinkat},
};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    fs::{self, File},
    io::{self, Read, Write},
    os::{fd::AsRawFd, unix::fs::DirBuilderExt},
    path::{Path, PathBuf},
    sync::Arc,
};
const MAX_ENTRY: u64 = 4096;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub pid: u32,
    pub start: u64,
    pub reservation: u64,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    dev: nix::libc::dev_t,
    ino: nix::libc::ino_t,
}
impl From<&FileStat> for Stamp {
    fn from(value: &FileStat) -> Self {
        Self {
            dev: value.st_dev,
            ino: value.st_ino,
        }
    }
}
pub struct Ledger {
    path: PathBuf,
    dir: File,
    stamp: Stamp,
    owner: Arc<()>,
}
pub struct Locked {
    lock: Flock<File>,
    stamp: Stamp,
    owner: Arc<()>,
}
#[derive(Debug)]
struct Finalization {
    primary: io::Error,
    cleanup: io::Error,
}
impl fmt::Display for Finalization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}; finalization: {}", self.primary, self.cleanup)
    }
}
impl std::error::Error for Finalization {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.primary)
    }
}
pub(crate) fn finalized<T>(body: io::Result<T>, cleanup: io::Result<()>) -> io::Result<T> {
    match (body, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(cleanup)) => Err(io::Error::other(Finalization { primary, cleanup })),
    }
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn regular(info: &FileStat, private: bool) -> io::Result<()> {
    if SFlag::from_bits_truncate(info.st_mode) != SFlag::S_IFREG
        || info.st_uid != geteuid().as_raw()
        || info.st_nlink != 1
        || info.st_mode & (if private { 0o077 } else { 0o022 }) != 0
    {
        return Err(invalid(
            "ledger file must be owned, single-link, regular and safely permissioned",
        ));
    }
    Ok(())
}
fn directory(info: &FileStat) -> io::Result<()> {
    if SFlag::from_bits_truncate(info.st_mode) != SFlag::S_IFDIR
        || info.st_uid != geteuid().as_raw()
        || info.st_mode & 0o077 != 0
    {
        return Err(invalid(
            "ledger directory must be owned, private and not a symlink",
        ));
    }
    Ok(())
}
impl Locked {
    /// Consumes the real lock once. An uncertain unlock retains its owner;
    /// it is never retried by Drop or counted as admission cleanup.
    pub fn close(self) -> io::Result<()> {
        match self.lock.unlock() {
            Ok(file) => close(file).map_err(io::Error::from),
            Err((lock, error)) => {
                std::mem::forget(lock);
                Err(io::Error::from(error))
            }
        }
    }
}
impl Ledger {
    pub fn open(path: &Path) -> io::Result<Self> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        let dir = File::from(open(
            path,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )?);
        let result = (|| {
            let info = fstat(&dir)?;
            directory(&info)?;
            Ok(Stamp::from(&info))
        })();
        match result {
            Ok(stamp) => {
                let ledger = Self {
                    path: path.to_path_buf(),
                    dir,
                    stamp,
                    owner: Arc::new(()),
                };
                match ledger.current() {
                    Ok(()) => Ok(ledger),
                    Err(error) => finalized(Err(error), ledger.close()),
                }
            }
            Err(error) => finalized(Err(error), close(dir).map_err(io::Error::from)),
        }
    }
    pub fn close(self) -> io::Result<()> {
        close(self.dir).map_err(io::Error::from)
    }
    fn current(&self) -> io::Result<()> {
        let held = fstat(&self.dir)?;
        let named = lstat(&self.path)?;
        directory(&held)?;
        directory(&named)?;
        if Stamp::from(&held) != self.stamp || Stamp::from(&named) != self.stamp {
            return Err(invalid("ledger directory changed"));
        }
        Ok(())
    }
    fn named(&self, name: &Path) -> io::Result<FileStat> {
        fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW).map_err(io::Error::from)
    }
    fn same(&self, name: &Path, stamp: Stamp) -> io::Result<()> {
        let named = self.named(name)?;
        regular(&named, false)?;
        if Stamp::from(&named) != stamp {
            return Err(invalid("ledger entry changed"));
        }
        Ok(())
    }
    fn held(&self, lock: &Locked) -> io::Result<()> {
        if !Arc::ptr_eq(&self.owner, &lock.owner) {
            return Err(invalid("lock belongs to another ledger"));
        }
        self.current()?;
        let info = fstat(&*lock.lock)?;
        regular(&info, true)?;
        if info.st_size != 0 || Stamp::from(&info) != lock.stamp {
            return Err(invalid("ledger lock changed"));
        }
        self.same(Path::new("lock"), lock.stamp)
    }
    pub fn lock(&self) -> io::Result<Locked> {
        self.current()?;
        let file = File::from(openat(
            &self.dir,
            "lock",
            OFlag::O_CREAT
                | OFlag::O_RDWR
                | OFlag::O_NOFOLLOW
                | OFlag::O_NONBLOCK
                | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )?);
        let result = (|| {
            let info = fstat(&file)?;
            regular(&info, true)?;
            if info.st_size != 0 {
                return Err(invalid("ledger lock is not empty"));
            }
            self.same(Path::new("lock"), Stamp::from(&info))?;
            Ok(Stamp::from(&info))
        })();
        let stamp = match result {
            Ok(stamp) => stamp,
            Err(error) => return finalized(Err(error), close(file).map_err(io::Error::from)),
        };
        let lock = match Flock::lock(file, FlockArg::LockExclusive) {
            Ok(lock) => lock,
            Err((file, error)) => {
                return finalized(
                    Err(io::Error::from(error)),
                    close(file).map_err(io::Error::from),
                );
            }
        };
        let locked = Locked {
            lock,
            stamp,
            owner: self.owner.clone(),
        };
        match self.held(&locked) {
            Ok(()) => Ok(locked),
            Err(error) => finalized(Err(error), locked.close()),
        }
    }
    pub fn live(&self, held: &Locked, proc: &Path) -> Result<Vec<Entry>, GateError> {
        self.held(held)?;
        // The actual descriptor remains owned through enumeration. All later
        // entry IO is openat-relative, never through a rebound directory name.
        let alias = if cfg!(target_os = "linux") {
            "/proc/self/fd"
        } else {
            "/dev/fd"
        };
        let entries = fs::read_dir(Path::new(alias).join(self.dir.as_raw_fd().to_string()))?;
        let mut live = Vec::new();
        for item in entries {
            let name = PathBuf::from(item?.file_name());
            if name.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            match self.classify(&name, proc) {
                Holder::Live(entry) => live.push(entry),
                Holder::Stale(stamp) => {
                    self.held(held)?;
                    self.same(&name, stamp)?;
                    unlinkat(&self.dir, &name, UnlinkatFlags::NoRemoveDir)
                        .map_err(io::Error::from)?;
                    self.dir.sync_all()?;
                }
                Holder::Removed => {}
                Holder::Unknown(why) => {
                    return Err(GateError::UnknownHolder(format!(
                        "{}: {why}; inspect it without discarding a possible live reservation",
                        self.path.join(name).display()
                    )));
                }
            }
        }
        self.held(held)?;
        live.sort_by_key(|entry| entry.pid);
        Ok(live)
    }
    pub fn add(&self, held: &Locked, entry: Entry) -> io::Result<()> {
        self.held(held)?;
        let bytes = serde_json::to_vec(&entry).map_err(io::Error::other)?;
        let target = PathBuf::from(format!("{}.json", entry.pid));
        match self.named(&target) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "reservation already exists",
                ));
            }
        }
        let name = PathBuf::from(format!("{}.tmp", entry.pid));
        let mut file = File::from(openat(
            &self.dir,
            &name,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )?);
        let mut identity = None;
        let result = (|| {
            let info = fstat(&file)?;
            regular(&info, true)?;
            identity = Some(Stamp::from(&info));
            file.write_all(&bytes)?;
            file.sync_all()?;
            Ok(())
        })();
        match (result, close(file).map_err(io::Error::from)) {
            (Ok(()), Ok(())) => {}
            (Err(error), Ok(())) => {
                let cleanup = identity.map_or(Ok(()), |stamp| {
                    self.held(held)?;
                    self.same(&name, stamp)?;
                    unlinkat(&self.dir, &name, UnlinkatFlags::NoRemoveDir)?;
                    self.dir.sync_all()
                });
                return finalized(Err(error), cleanup);
            }
            (body, cleanup) => return finalized(body, cleanup),
        }
        self.held(held)?;
        self.same(&name, identity.expect("successful checked temporary"))?;
        renameat(&self.dir, &name, &self.dir, &target)?;
        self.dir.sync_all()?;
        self.held(held)
    }
    pub fn remove(&self, held: &Locked, pid: u32) -> io::Result<()> {
        self.held(held)?;
        let name = PathBuf::from(format!("{pid}.json"));
        match self.read_entry(&name) {
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    && self
                        .named(&name)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
            Ok((entry, stamp)) => {
                if entry.pid != pid {
                    return Err(invalid("reservation pid differs from its name"));
                }
                self.same(&name, stamp)?;
                unlinkat(&self.dir, &name, UnlinkatFlags::NoRemoveDir)?;
                self.dir.sync_all()?;
                self.held(held)
            }
        }
    }
    fn read_entry(&self, name: &Path) -> io::Result<(Entry, Stamp)> {
        let mut file = File::from(openat(
            &self.dir,
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )?);
        let result = (|| {
            let info = fstat(&file)?;
            regular(&info, false)?;
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take(MAX_ENTRY + 1)
                .read_to_end(&mut bytes)?;
            if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_ENTRY {
                return Err(invalid("reservation exceeds entry bound"));
            }
            let entry = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            self.same(name, Stamp::from(&info))?;
            Ok((entry, Stamp::from(&info)))
        })();
        finalized(result, close(file).map_err(io::Error::from))
    }
    fn classify(&self, name: &Path, proc: &Path) -> Holder {
        let (entry, stamp) = match self.read_entry(name) {
            Ok(value) => value,
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    && self
                        .named(name)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                return Holder::Removed;
            }
            Err(error) => return Holder::Unknown(format!("unreadable reservation ({error})")),
        };
        if name.file_stem().and_then(|stem| stem.to_str()) != Some(entry.pid.to_string().as_str()) {
            return Holder::Unknown(format!("holds pid {} under another name", entry.pid));
        }
        match process(proc, entry.pid) {
            Process::Gone => Holder::Stale(stamp),
            Process::Started(start) if start == entry.start => Holder::Live(entry),
            Process::Started(_) => Holder::Stale(stamp),
            Process::Unknown(why) => {
                Holder::Unknown(format!("pid {} not checkable ({why})", entry.pid))
            }
        }
    }
}
enum Holder {
    Live(Entry),
    Stale(Stamp),
    Removed,
    Unknown(String),
}
