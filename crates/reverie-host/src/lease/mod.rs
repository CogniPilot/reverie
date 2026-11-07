//! Native lease directories with the contract of
//! `python/reverie/cleanup/lease.py` (contract r10): kernel `flock` holders,
//! time-bound reservations, the destructive janitor's barriers and the
//! non-destructive retirement inventory. Liveness is only a kernel lock or a
//! well-formed reservation window, never a PID, heartbeat or metadata.
//!
//! A lease directory has one never-unlinked `barrier.lock`. Every acquisition
//! takes it shared for milliseconds; the janitor and retirement take it
//! exclusive, so no new lease appears between their scan and their effect.
//! Each leased directory `D` (keyed `<st_dev>-<st_ino>` by `lstat`) has
//! `<key>.lock`, one `<key>.path.json`, a `<key>.<pid>.json` per live holder
//! and an optional `<key>.reserve.json`. Exact record bytes come from
//! `reverie_contracts::lease_records`.
mod hold;
mod janitor;
mod retirement;
#[cfg(test)]
mod tests;

use crate::native;
use nix::fcntl::{Flock, FlockArg};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub use hold::{HeldLeases, hold, reserve, unreserve};
pub use janitor::{Janitor, WalkBound, check, janitor};
pub use retirement::{DirectPaths, Retirement, RetirementPaths, RetirementSummary, retirement};
pub use reverie_contracts::lease_records::ReservationState;

/// The CLI exit code and library class of a refusal (`code` in Python).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseCode {
    /// 1: a live lease or reservation protects the tree.
    InUse,
    /// 2: missing, malformed or unreadable evidence; never treated as free.
    Unknown,
    /// 3: a busy barrier, or a directory that was removed or replaced.
    Busy,
}

/// `check`'s answer, also its CLI exit code: 0 free, 1 in use, 2 unknown.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CheckState {
    Free,
    InUse,
    Unknown,
}

/// A lease refusal. Messages are the Python strings; operating-system
/// error text is Rust's, not Python's `[Errno N]` spelling.
#[derive(Debug)]
pub struct LeaseError {
    code: LeaseCode,
    message: String,
}
impl LeaseError {
    fn new(code: LeaseCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn unknown(message: impl Into<String>) -> Self {
        Self::new(LeaseCode::Unknown, message)
    }
    fn busy(message: impl Into<String>) -> Self {
        Self::new(LeaseCode::Busy, message)
    }
    fn in_use(message: impl Into<String>) -> Self {
        Self::new(LeaseCode::InUse, message)
    }
    #[must_use]
    pub fn code(&self) -> LeaseCode {
        self.code
    }
}
impl std::fmt::Display for LeaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for LeaseError {}
impl From<std::io::Error> for LeaseError {
    fn from(error: std::io::Error) -> Self {
        Self::unknown(error.to_string())
    }
}
impl From<nix::errno::Errno> for LeaseError {
    fn from(error: nix::errno::Errno) -> Self {
        std::io::Error::from(error).into()
    }
}
pub type Result<T> = std::result::Result<T, LeaseError>;

/// One lease directory, checked for its purpose.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct LeaseBase {
    path: PathBuf,
}
impl LeaseBase {
    /// `leases_dir()` for a holder's own directory: refuse a symlink, then
    /// create it (mode 0700; missing parents get the default mode).
    pub fn own(path: &Path) -> Result<Self> {
        if is_symlink(path) {
            return Err(LeaseError::unknown(format!(
                "leases dir must not be a symlink: {}",
                path.display()
            )));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }
    /// `_scan_base`: a directory the janitor must check. Missing, symlinked
    /// or unreadable is UNKNOWN, and it is never created here.
    pub fn scan(path: &Path) -> Result<Self> {
        let readable = nix::unistd::access(
            path,
            nix::unistd::AccessFlags::R_OK | nix::unistd::AccessFlags::X_OK,
        )
        .is_ok();
        if is_symlink(path) || !path.is_dir() || !readable {
            return Err(LeaseError::unknown(format!(
                "lease dir missing, symlinked or unreadable: {}",
                path.display()
            )));
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
    fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|info| info.file_type().is_symlink())
}

/// `key_of`: `<st_dev>-<st_ino>` by `lstat`; `None` when the path is absent.
pub fn key_of(directory: &Path) -> Result<Option<String>> {
    match std::fs::symlink_metadata(directory) {
        Ok(info) if info.is_dir() => Ok(Some(format!("{}-{}", info.dev(), info.ino()))),
        Ok(_) => Err(LeaseError::unknown(format!(
            "lease target must be a real directory: {}",
            directory.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// `_reservation_state(base, key)`: absent is FREE, unreadable is UNKNOWN.
#[must_use]
pub fn reservation_state(base: &LeaseBase, key: &str) -> ReservationState {
    let raw = match std::fs::read(base.join(&format!("{key}.reserve.json"))) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return ReservationState::Unknown,
    };
    reverie_contracts::lease_records::reservation_file_state(raw.as_deref(), now())
}

/// `os.path.abspath`: join the working directory, then POSIX `normpath`,
/// which is lexical and keeps exactly two leading slashes.
pub(crate) fn abspath(path: &Path) -> Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let bytes = joined.as_os_str().as_bytes();
    let leading = bytes.iter().take_while(|byte| **byte == b'/').count();
    let mut parts: Vec<&[u8]> = Vec::new();
    for part in bytes.split(|byte| *byte == b'/') {
        match part {
            b"" | b"." => {}
            b".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let mut normal = if leading == 2 {
        b"//".to_vec()
    } else {
        b"/".to_vec()
    };
    normal.extend(parts.join(&b'/'));
    Ok(PathBuf::from(OsString::from_vec(normal)))
}

/// Python `str` codepoints of a host path (surrogate escapes included).
pub(crate) fn text(path: &Path) -> Vec<u32> {
    native::python_text(path)
}

pub(crate) fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64())
}

/// `_open`: O_NOFOLLOW and O_CLOEXEC, with mode 0600 when creating.
fn open(path: &Path, flags: i32) -> Result<File> {
    Ok(native::open_at_mode(
        libc::AT_FDCWD,
        path.as_os_str(),
        flags,
        0o600,
    )?)
}

/// A held shared or exclusive `barrier.lock`, released on drop.
pub(crate) struct Barrier {
    _lock: Flock<File>,
}

/// `_barrier`: retry every 50 ms until `wait`; zero means one attempt. The
/// file is never unlinked, so concurrent creators share one inode. A root
/// janitor hands a file it creates to the lease directory's owner.
pub(crate) fn barrier(base: &LeaseBase, exclusive: bool, wait: Duration) -> Result<Barrier> {
    let file = open(&base.join("barrier.lock"), libc::O_RDWR | libc::O_CREAT)?;
    if nix::unistd::geteuid().is_root() {
        let owner = std::fs::metadata(base.path())?;
        let held = file.metadata()?;
        if (held.uid(), held.gid()) != (owner.uid(), owner.gid()) {
            nix::unistd::fchown(&file, Some(owner.uid().into()), Some(owner.gid().into()))?;
        }
    }
    let mode = if exclusive {
        FlockArg::LockExclusiveNonblock
    } else {
        FlockArg::LockSharedNonblock
    };
    let deadline = Instant::now() + wait;
    let mut file = file;
    loop {
        match Flock::lock(file, mode) {
            Ok(lock) => return Ok(Barrier { _lock: lock }),
            Err((_, nix::errno::Errno::EWOULDBLOCK)) if Instant::now() >= deadline => {
                return Err(LeaseError::busy(
                    "lease barrier busy (a cleanup is deleting); try again",
                ));
            }
            Err((returned, nix::errno::Errno::EWOULDBLOCK)) => {
                file = returned;
                std::thread::sleep(Duration::from_millis(50));
            }
            Err((_, error)) => return Err(error.into()),
        }
    }
}

/// `_write_json`: `.<name>.tmp` truncated (0600, no follow), then renamed.
pub(crate) fn write_record(base: &LeaseBase, name: &str, bytes: &[u8]) -> Result<()> {
    let temporary = base.join(&format!(".{name}.tmp"));
    let mut file = open(&temporary, libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC)?;
    let written = file.write_all(bytes);
    native::close(file).map_err(|error| LeaseError::unknown(error.to_string()))?;
    written?;
    std::fs::rename(&temporary, base.join(name))?;
    Ok(())
}

/// `_ensure_path_record`: written once, under the caller's shared barrier.
pub(crate) fn ensure_path_record(base: &LeaseBase, key: &str, directory: &Path) -> Result<()> {
    let name = format!("{key}.path.json");
    if base.join(&name).exists() {
        return Ok(());
    }
    let bytes = reverie_contracts::lease_records::path_record_bytes(&text(directory), now());
    write_record(base, &name, &bytes)
}

/// `_holder_files`: `<key>.*.json` except reservation and path records.
pub(crate) fn holder_files(base: &LeaseBase, key: &str) -> Result<Vec<PathBuf>> {
    let prefix = format!("{key}.");
    let mut found = Vec::new();
    for entry in std::fs::read_dir(base.path())? {
        let name = entry?.file_name();
        let name = name.as_bytes();
        let holder = name.len() >= prefix.len() + 5
            && name.starts_with(prefix.as_bytes())
            && name.ends_with(b".json")
            && !name.ends_with(b".reserve.json")
            && !name.ends_with(b".path.json");
        if holder {
            found.push(base.path().join(OsStr::from_bytes(name)));
        }
    }
    Ok(found)
}

/// `_metadata(base, key)[1]`: a malformed path record or holder record.
pub(crate) fn malformed_metadata(base: &LeaseBase, key: &str) -> Result<bool> {
    use reverie_contracts::lease_records::{PathRecord, holder_record_parses, path_record};
    let malformed_path = match std::fs::read(base.join(&format!("{key}.path.json"))) {
        Ok(raw) => path_record(&raw) == PathRecord::Malformed,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    };
    let mut malformed = malformed_path;
    for path in holder_files(base, key)? {
        malformed |= std::fs::read(path).map_or(true, |raw| !holder_record_parses(&raw));
    }
    Ok(malformed)
}
