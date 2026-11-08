//! Shared holders (`hold`) and reservations (`reserve`, `unreserve`).
use super::{
    LeaseBase, LeaseError, Result, abspath, barrier, barrier_until, ensure_path_record, key_of,
    now, open, text, write_record,
};
use nix::fcntl::{Flock, FlockArg};
use reverie_contracts::lease_records::{self, HolderRecord};
use std::fs::File;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// A probe may hold a lock exclusively for an instant (r9 N1): retry, then refuse.
const SHARED_RETRY: Duration = Duration::from_millis(500);

/// Shared leases held until drop. Each holder record is unlinked while its
/// lock is still held; lock files are never unlinked at release.
pub struct HeldLeases {
    keys: Vec<String>,
    records: Vec<PathBuf>,
    locks: Vec<Flock<File>>,
}
impl HeldLeases {
    /// Keys in acquisition (sorted) order.
    #[must_use]
    pub fn keys(&self) -> &[String] {
        &self.keys
    }
}
impl std::fmt::Debug for HeldLeases {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeldLeases")
            .field("keys", &self.keys)
            .finish_non_exhaustive()
    }
}
impl Drop for HeldLeases {
    fn drop(&mut self) {
        for record in &self.records {
            // Python ignores only a missing record here; nothing can be raised from drop.
            let _ = std::fs::remove_file(record);
        }
        self.locks.clear();
    }
}

/// `hold`: stat every directory, take the barrier shared, then per key in
/// sorted order open/create the lock, take it shared (≤ 5 tries against a
/// split inode left by gc), re-stat the directory, write the records and
/// release the barrier. `argv0` is recorded by basename.
pub fn hold(
    base: &LeaseBase,
    directories: &[PathBuf],
    argv0: &Path,
    wait: Duration,
) -> Result<HeldLeases> {
    hold_cancellable(base, directories, argv0, wait, &|| false)
}

/// `hold`, whose busy-barrier wait ends once `cancelled` holds, before any
/// lock or record exists. Later steps are bounded and run to completion.
pub fn hold_cancellable(
    base: &LeaseBase,
    directories: &[PathBuf],
    argv0: &Path,
    wait: Duration,
    cancelled: &dyn Fn() -> bool,
) -> Result<HeldLeases> {
    let mut keyed = Vec::with_capacity(directories.len());
    for directory in directories {
        let directory = abspath(directory)?;
        let key = key_of(&directory)?.ok_or_else(|| {
            LeaseError::busy(format!("directory is missing: {}", directory.display()))
        })?;
        keyed.push((key, directory));
    }
    keyed.sort_by(|left, right| {
        (left.0.as_str(), text(&left.1)).cmp(&(right.0.as_str(), text(&right.1)))
    });
    let mut held = HeldLeases {
        keys: Vec::new(),
        records: Vec::new(),
        locks: Vec::new(),
    };
    let _barrier = barrier_until(base, false, wait, cancelled)?;
    for (key, directory) in &keyed {
        held.locks.push(shared_lock(base, key, directory)?);
        let current = match key_of(directory) {
            Ok(current) => current,
            Err(error) if error.message.starts_with("lease target must be") => None,
            Err(error) => return Err(error),
        };
        if current.as_deref() != Some(key.as_str()) {
            return Err(LeaseError::busy(format!(
                "directory was removed or replaced: {}",
                directory.display()
            )));
        }
    }
    let pid = std::process::id();
    let argv0 = argv0.file_name().map_or_else(Vec::new, |name| {
        reverie_core::posix_text::decode(std::os::unix::ffi::OsStrExt::as_bytes(name))
    });
    for (key, directory) in &keyed {
        ensure_path_record(base, key, directory)?;
        let record = HolderRecord {
            path: &text(directory),
            pid,
            start: process_field(pid, 19),
            argv0: &argv0,
            utc: now(),
            session: process_field(pid, 3)
                .and_then(|sid| u32::try_from(sid).ok())
                .unwrap_or(0),
        };
        let name = format!("{key}.{pid}.json");
        held.records.push(base.path().join(&name));
        write_record(base, &name, &lease_records::holder_record_bytes(&record))?;
    }
    held.keys = keyed.into_iter().map(|(key, _)| key).collect();
    Ok(held)
}

fn shared_lock(base: &LeaseBase, key: &str, directory: &Path) -> Result<Flock<File>> {
    let lock = base.path().join(format!("{key}.lock"));
    for _attempt in 0..5 {
        let mut file = open(&lock, libc::O_RDWR | libc::O_CREAT)?;
        let deadline = Instant::now() + SHARED_RETRY;
        let locked = loop {
            match Flock::lock(file, FlockArg::LockSharedNonblock) {
                Ok(locked) => break locked,
                Err((_, nix::errno::Errno::EWOULDBLOCK)) if Instant::now() >= deadline => {
                    return Err(LeaseError::busy(format!(
                        "lease held exclusively outside the barrier: {}",
                        directory.display()
                    )));
                }
                Err((returned, nix::errno::Errno::EWOULDBLOCK)) => {
                    file = returned;
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err((_, error)) => return Err(error.into()),
            }
        };
        if names_file(&lock, &locked)? {
            return Ok(locked);
        }
    }
    Err(LeaseError::busy(format!(
        "lock file kept changing under us: {}",
        directory.display()
    )))
}

/// `_names_fd`: the path still names the held inode.
fn names_file(path: &Path, file: &File) -> Result<bool> {
    let named = match std::fs::symlink_metadata(path) {
        Ok(named) => named,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let held = file.metadata()?;
    Ok((named.dev(), named.ino()) == (held.dev(), held.ino()))
}

/// A numeric `/proc/<pid>/stat` field counted after the command name:
/// 3 is the session (`os.getsid(0)`), 19 the start time (`_pid_start`).
fn process_field(pid: u32, index: usize) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(index)?
        .parse()
        .ok()
}

/// `reserve`: a time-bound reservation (`90m`, `6h`, `1d`; at most 24 h),
/// written under the shared barrier. An empty owner records `$USER`.
/// `renew` requires the current reservation to name the same path.
pub fn reserve(
    base: &LeaseBase,
    directory: &Path,
    duration: &str,
    owner: &str,
    compute_lease_id: Option<&str>,
    wait: Duration,
    renew: bool,
) -> Result<String> {
    let directory = abspath(directory)?;
    let seconds = lease_records::reservation_seconds(duration).ok_or_else(|| {
        if duration_shape(duration) {
            LeaseError::unknown("a reservation lasts more than 0 and at most 24 h")
        } else {
            LeaseError::unknown(format!("duration must look like 90m, 6h or 1d: {duration}"))
        }
    })?;
    let _barrier = barrier(base, false, wait)?;
    let key = key_of(&directory)?.ok_or_else(|| {
        LeaseError::busy(format!("directory is missing: {}", directory.display()))
    })?;
    let name = format!("{key}.reserve.json");
    if renew {
        let current = std::fs::read(base.path().join(&name))
            .ok()
            .and_then(|raw| lease_records::renewable_path(&raw));
        if current.as_deref() != Some(text(&directory).as_slice()) {
            return Err(LeaseError::unknown(format!(
                "no reservation to renew: {}",
                directory.display()
            )));
        }
    }
    let owner = if owner.is_empty() {
        std::env::var_os("USER").unwrap_or_default()
    } else {
        owner.into()
    };
    let owner =
        reverie_core::posix_text::decode(std::os::unix::ffi::OsStrExt::as_bytes(owner.as_os_str()));
    let compute = compute_lease_id.map(|id| id.chars().map(u32::from).collect::<Vec<_>>());
    let bytes = lease_records::reservation_bytes(
        &text(&directory),
        now(),
        seconds,
        &owner,
        compute.as_deref(),
    );
    ensure_path_record(base, &key, &directory)?;
    write_record(base, &name, &bytes)?;
    Ok(key)
}

/// Whether `_parse_duration`'s pattern matched, so the bound message applies.
/// Character-safe: the unit is stripped as a char, never sliced by byte.
fn duration_shape(text: &str) -> bool {
    text.strip_suffix(['s', 'm', 'h', 'd'])
        .is_some_and(|digits| {
            !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// `unreserve`: drop the reservation under the shared barrier.
pub fn unreserve(base: &LeaseBase, directory: &Path, wait: Duration) -> Result<()> {
    let directory = abspath(directory)?;
    let _barrier = barrier(base, false, wait)?;
    let key = key_of(&directory)?.ok_or_else(|| {
        LeaseError::busy(format!("directory is missing: {}", directory.display()))
    })?;
    match std::fs::remove_file(base.path().join(format!("{key}.reserve.json"))) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
