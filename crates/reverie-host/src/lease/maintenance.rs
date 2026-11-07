//! Lease-directory maintenance for people and receipts: `gc` and `ls`.
use super::{
    LeaseBase, LeaseCode, ReservationState, Result, barrier, holder_files, key_of,
    malformed_metadata, open, reservation_state,
};
use crate::native;
use nix::fcntl::{Flock, FlockArg};
use reverie_contracts::lease_records::{PathRecord, path_record};
use std::path::PathBuf;
use std::time::Duration;

/// `gc`'s report: removed keys and kept legacy locks without a path record.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GcReport {
    pub removed: Vec<String>,
    pub kept_no_path_record: Vec<String>,
}

/// One held or reserved lease in `ls`.
#[derive(Clone, Debug, PartialEq)]
pub struct LeaseListing {
    pub key: String,
    pub held: bool,
    pub reserved: bool,
    pub malformed_metadata: bool,
    /// The registered path as Python `str` code points (surrogate escapes kept).
    pub path: Option<Vec<u32>>,
    /// Holder records that parse as JSON, as their raw bytes.
    pub holders: Vec<Vec<u8>>,
}

/// `ls`: busy while an acquisition or cleanup holds the barrier, never free.
#[derive(Clone, Debug, PartialEq)]
pub enum Listing {
    Busy,
    Leases(Vec<LeaseListing>),
}

/// Lock keys in sorted name order, excluding `barrier.lock` and hidden names.
fn lock_keys(base: &LeaseBase) -> Result<Vec<String>> {
    let mut keys = Vec::new();
    for entry in std::fs::read_dir(base.path())? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if let Some(key) = name
            .strip_suffix(".lock")
            .filter(|key| !name.starts_with('.') && *key != "barrier")
        {
            keys.push(key.to_owned());
        }
    }
    keys.sort();
    Ok(keys)
}

/// `_path_record`: the registered path text, `Ok(None)` when absent.
fn registered(base: &LeaseBase, key: &str) -> std::result::Result<Option<Vec<u32>>, ()> {
    match std::fs::read(base.path().join(format!("{key}.path.json"))) {
        Ok(raw) => match path_record(&raw) {
            PathRecord::Path(path) => Ok(Some(path)),
            PathRecord::Malformed => Err(()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

fn remove(path: PathBuf) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// `gc` (§2M), under the exclusive barrier (60 s). For every lock it can
/// take exclusively: drop records of dead holders; if the registered
/// directory is gone or replaced, remove the lock, path record and
/// reservation. A lock without a path record is kept and reported.
pub fn gc(base: &LeaseBase) -> Result<GcReport> {
    let _barrier = barrier(base, true, Duration::from_secs(60))?;
    let mut report = GcReport::default();
    for key in lock_keys(base)? {
        let lock = base.path().join(format!("{key}.lock"));
        let _held = match Flock::lock(open(&lock, libc::O_RDWR)?, FlockArg::LockExclusiveNonblock) {
            Ok(held) => held,
            Err((_, nix::errno::Errno::EWOULDBLOCK)) => continue,
            Err((_, error)) => return Err(error.into()),
        };
        for stale in holder_files(base, &key)? {
            remove(stale)?;
        }
        let path = match registered(base, &key) {
            Ok(Some(path)) => path,
            Ok(None) => {
                report.kept_no_path_record.push(key);
                continue;
            }
            Err(()) => {
                report
                    .kept_no_path_record
                    .push(format!("{key} (malformed path record)"));
                continue;
            }
        };
        let current = match native::python_path(&path).map(|path| key_of(&path)) {
            Ok(Ok(current)) => current,
            Ok(Err(error)) if !error.message.starts_with("lease target must be") => {
                return Err(error);
            }
            _ => None,
        };
        if current.as_deref() != Some(key.as_str()) {
            remove(base.path().join(format!("{key}.reserve.json")))?;
            remove(base.path().join(format!("{key}.path.json")))?;
            remove(lock)?;
            report.removed.push(key);
        }
    }
    Ok(report)
}

/// `ls`: held leases and live reservations with their metadata.
pub fn ls(base: &LeaseBase) -> Result<Listing> {
    let _barrier = match barrier(base, true, Duration::ZERO) {
        Ok(barrier) => barrier,
        Err(error) if error.code() == LeaseCode::Busy => return Ok(Listing::Busy),
        Err(error) => return Err(error),
    };
    let mut out = Vec::new();
    for key in lock_keys(base)? {
        let file = open(&base.path().join(format!("{key}.lock")), libc::O_RDONLY)?;
        let held = match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(_free) => false,
            Err((_, nix::errno::Errno::EWOULDBLOCK)) => true,
            Err((_, error)) => return Err(error.into()),
        };
        let reserved = reservation_state(base, &key) == ReservationState::InUse;
        if !(held || reserved) {
            continue;
        }
        let holders = holder_files(base, &key)?
            .into_iter()
            .filter_map(|path| std::fs::read(path).ok())
            .filter(|raw| reverie_contracts::lease_records::holder_record_parses(raw))
            .collect();
        let path = registered(base, &key).ok().flatten();
        out.push(LeaseListing {
            malformed_metadata: malformed_metadata(base, &key)?,
            key,
            held,
            reserved,
            path,
            holders,
        });
    }
    Ok(Listing::Leases(out))
}
