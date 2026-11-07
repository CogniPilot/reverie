//! Actual stable kernel barriers and existing-lock custody, held across cold
//! observation/effects. Metadata rows alone never establish a live lease.
use super::directories::Directory;
use super::*;
mod keys;
mod retained;
pub(super) use keys::ClearKeys;
use reverie_contracts::worker_cold_tmp::{
    ClearReservation, ColdConfiguration, ColdLeaseState, clear_holder_metadata, clear_path_metadata,
};
use std::{
    ffi::OsStr,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    time::{SystemTime, UNIX_EPOCH},
};
pub(super) struct Bases {
    bases: Vec<Base>,
}
struct Base {
    directory: Directory,
    barrier: Option<File>,
    locks: Vec<File>,
}
impl Bases {
    pub(super) fn capture(
        policy: &ColdConfiguration,
        home: &PosixPath,
        target: &PosixPath,
        uid: u32,
    ) -> Result<Self> {
        let own = home.join(&PosixPath::from_scalar_text(".local/state/reverie/leases"));
        let mut selected = vec![own];
        for host in policy.host_lease_directories() {
            selected.push(
                PosixPath::try_new(host.codepoints())
                    .map_err(|_| StorageError::Refused(StorageFault::CanonicalPath))?,
            );
        }
        let mut value = Self { bases: Vec::new() };
        let result = (|| {
            let mut seen = BTreeSet::new();
            for text in selected {
                need(
                    seen.insert(text.codepoints()) && !text.is_relative_to(target),
                    StorageFault::ColdLease,
                )?;
                value.bases.push(Base {
                    directory: Directory::open(text, uid)?,
                    barrier: None,
                    locks: Vec::new(),
                });
            }
            // Python sorts the configured path strings, not fsencoded bytes.
            value
                .bases
                .sort_by_key(|base| base.directory.text.codepoints());
            Ok(())
        })();
        match result {
            Ok(()) => Ok(value),
            Err(error) => finalized(Err(error), value.close()),
        }
    }
    pub(super) fn barriers(&mut self, end: Instant) -> Result<()> {
        for base in &mut self.bases {
            check(end)?;
            base.directory.check()?;
            need(base.barrier.is_none(), StorageFault::ColdLease)?;
            let barrier = native::open_at_mode(
                base.directory.file.as_raw_fd(),
                OsStr::new("barrier.lock"),
                libc::O_RDWR | libc::O_CREAT | libc::O_NONBLOCK,
                0o600,
            )?;
            base.barrier = Some(barrier);
            let barrier = base.barrier.as_ref().expect("adopted barrier");
            base.barrier_owner(barrier)?;
            barrier
                .try_lock()
                .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
        }
        self.check(end)
    }
    pub(super) fn check(&self, end: Instant) -> Result<()> {
        check(end)?;
        for base in &self.bases {
            base.directory.check()?;
        }
        Ok(())
    }
    pub(super) fn clear_locks(&mut self, keys: &BTreeSet<String>, end: Instant) -> Result<()> {
        self.check(end)?;
        for base in &self.bases {
            for key in keys {
                check(end)?;
                base.reservation(key, end)?;
            }
        }
        for base in &mut self.bases {
            for key in keys {
                check(end)?;
                base.clear_lock(key, end)?;
            }
        }
        self.check(end)
    }
    pub(super) fn close(mut self) -> Result<()> {
        let mut result = Ok(());
        while let Some(mut base) = self.bases.pop() {
            while let Some(file) = base.locks.pop() {
                result = finalized(result, fs::close(file));
            }
            if let Some(file) = base.barrier.take() {
                result = finalized(result, fs::close(file));
            }
            result = finalized(result, base.directory.close());
        }
        result
    }
}
fn holder_name(name: &OsStr, key: &str) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let name = name.as_bytes();
    let prefix = format!("{key}.");
    name.starts_with(prefix.as_bytes())
        && name.ends_with(b".json")
        && name.len() >= prefix.len() + 5
        && !name.ends_with(b".reserve.json")
        && !name.ends_with(b".path.json")
}
impl Base {
    fn barrier_owner(&self, barrier: &File) -> Result<()> {
        if !nix::unistd::geteuid().is_root() {
            return Ok(());
        }
        let owner = self.directory.file.metadata()?;
        let held = barrier.metadata()?;
        if (held.uid(), held.gid()) != (owner.uid(), owner.gid()) {
            nix::unistd::fchown(
                barrier,
                Some(nix::unistd::Uid::from_raw(owner.uid())),
                Some(nix::unistd::Gid::from_raw(owner.gid())),
            )
            .map_err(std::io::Error::from)?;
        }
        Ok(())
    }
    fn reservation(&self, key: &str, end: Instant) -> Result<()> {
        let raw = self.read(&OsString::from(format!("{key}.reserve.json")), end)?;
        let parsed = ClearReservation::decode(raw.as_deref());
        let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(value) => value.as_secs_f64(),
            Err(error) => -error.duration().as_secs_f64(),
        };
        need(
            parsed
                .state(now)
                .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?
                == ColdLeaseState::Free,
            StorageFault::ColdLease,
        )
    }
    fn clear_lock(&mut self, key: &str, end: Instant) -> Result<()> {
        let leaf = OsString::from(format!("{key}.lock"));
        // Path.exists follows the leaf, including broken-symlink absence.
        // Actual existing-lock acquisition retains the source's NOFOLLOW.
        if !self.exists(&leaf)? {
            return Ok(());
        }
        let path = self.read(&OsString::from(format!("{key}.path.json")), end)?;
        clear_path_metadata(path.as_deref())
            .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
        for name in raw_names(&self.directory.file, usize::MAX, end)? {
            if holder_name(&name, key) {
                let raw = self
                    .read(&name, end)?
                    .ok_or(StorageError::Refused(StorageFault::ColdLease))?;
                clear_holder_metadata(&raw)
                    .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
            }
        }
        let file = native::open_at(
            self.directory.file.as_raw_fd(),
            &leaf,
            libc::O_RDWR | libc::O_NONBLOCK,
        )?;
        self.locks.push(file);
        self.locks
            .last()
            .expect("adopted lock")
            .try_lock()
            .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
        Ok(())
    }
    fn selected(&self, name: &OsStr) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.file.as_raw_fd())).join(name)
    }
    fn exists(&self, name: &OsStr) -> Result<bool> {
        match std::fs::metadata(self.selected(name)) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    fn read(&self, name: &OsStr, end: Instant) -> Result<Option<Vec<u8>>> {
        check(end)?;
        // Follow the regular metadata leaf like Path.read_text, but first pin
        // its object without opening a FIFO/device/socket payload. Safe Nix
        // transfers the actual OwnedFd; no new syscall implementation is added.
        let anchor = nix::fcntl::openat(
            &self.directory.file,
            name,
            nix::fcntl::OFlag::O_PATH | nix::fcntl::OFlag::O_CLOEXEC,
            nix::sys::stat::Mode::empty(),
        );
        let anchor = match anchor {
            Ok(fd) => File::from(fd),
            Err(nix::errno::Errno::ENOENT) => return Ok(None),
            Err(error) => return Err(std::io::Error::from(error).into()),
        };
        let result = (|| {
            need(anchor.metadata()?.is_file(), StorageFault::ColdLease)?;
            self.read_regular(&anchor, end)
        })();
        finalized(result, fs::close(anchor))
    }
    fn read_regular(&self, anchor: &File, end: Instant) -> Result<Option<Vec<u8>>> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(PathBuf::from(format!(
                "/proc/self/fd/{}",
                anchor.as_raw_fd()
            )));
        let mut file = file?;
        let result = read_chunks(&mut file, end).map(Some);
        finalized(result, fs::close(file))
    }
}
fn read_chunks(file: &mut File, end: Instant) -> Result<Vec<u8>> {
    need(file.metadata()?.is_file(), StorageFault::ColdLease)?;
    let mut raw = Vec::new();
    let mut buffer = [0; 65536];
    loop {
        check(end)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(raw);
        }
        raw.try_reserve(count)
            .map_err(|_| StorageError::Refused(StorageFault::ColdBound))?;
        raw.extend_from_slice(&buffer[..count]);
    }
}
