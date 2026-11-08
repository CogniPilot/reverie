//! `retirement`: canonical barriers for non-destructive tree retirement,
//! without a walk. Every registered record is classified from pinned
//! path/key metadata; a live related root, ancestor or descendant refuses,
//! and missing or ambiguous active evidence refuses. All barriers and the
//! relevant existing kernel locks stay held until the value is dropped.
//! This is not the destructive janitor's subtree inode oracle.
use super::{Barrier, LeaseBase, LeaseError, ReservationState, Result, barrier, key_of, now};
use crate::native;
use nix::fcntl::{AtFlags, Flock, FlockArg};
use reverie_contracts::lease_records::{LeaseRecord, LeaseRecordError};
use std::ffi::OsStr;
use std::fs::File;
use std::io::Read;
use std::num::NonZeroUsize;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const RECORD_BYTES: u64 = 65536;
const PATH_BYTES: usize = 4096;
const PHYSICAL_PATHS: usize = 32;

/// How an active registered path maps to physical host paths.
pub trait RetirementPaths {
    /// One to 32 canonical physical paths for `path`, registered under `key`.
    fn physical(&mut self, path: &Path, key: &str) -> Result<Vec<PathBuf>>;
    /// A trusted synchronous relation, such as a host-mount alias.
    fn related(&mut self, _physical: &Path) -> Result<bool> {
        Ok(false)
    }
}

/// Python's defaults: `(path.resolve(strict=True),)` and no extra relation.
pub struct DirectPaths;
impl RetirementPaths for DirectPaths {
    fn physical(&mut self, path: &Path, _key: &str) -> Result<Vec<PathBuf>> {
        Ok(vec![std::fs::canonicalize(path)?])
    }
}

/// `{'registeredRecords', 'relevantKeys', 'treeWalkPerformed': False}`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetirementSummary {
    pub registered_records: usize,
    pub relevant_keys: usize,
}

struct HeldBase {
    base: LeaseBase,
    directory: File,
    stamp: (u64, u64, u32, u32),
}

/// The held retirement inventory. `finish` repeats the base checks that
/// Python runs when its `with` block exits; dropping releases without them.
pub struct Retirement {
    summary: RetirementSummary,
    deadline: Instant,
    bases: Vec<HeldBase>,
    _locks: Vec<Flock<File>>,
    _barriers: Vec<Barrier>,
}
impl Retirement {
    #[must_use]
    pub fn summary(&self) -> RetirementSummary {
        self.summary
    }
    pub fn finish(self) -> Result<()> {
        validate_bases(&self.bases, self.deadline)
    }
}

/// One registered file name: `<key>.(lock|path.json|reserve.json|<pid>.json)`.
#[derive(Clone, Copy, Eq, PartialEq)]
enum Kind {
    Lock,
    Reserve,
    Other,
}

/// Registered file names of one key, in listing order.
type Names = Vec<(Vec<u8>, Kind)>;

fn classify(name: &[u8]) -> Option<(String, Kind)> {
    let digits = |part: &[u8]| !part.is_empty() && part.iter().all(u8::is_ascii_digit);
    let dot = name.iter().position(|byte| *byte == b'.')?;
    let (key, rest) = (&name[..dot], &name[dot + 1..]);
    let (device, inode) = key.split_at(key.iter().position(|byte| *byte == b'-')?);
    if !digits(device) || !digits(&inode[1..]) {
        return None;
    }
    let kind = match rest {
        b"lock" => Kind::Lock,
        b"reserve.json" => Kind::Reserve,
        b"path.json" => Kind::Other,
        holder if holder.strip_suffix(b".json").is_some_and(digits) => Kind::Other,
        _ => return None,
    };
    Some((String::from_utf8(key.to_vec()).ok()?, kind))
}

fn deadline_check(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(LeaseError::unknown("retirement lease deadline exhausted"));
    }
    Ok(())
}

/// `retirement(candidate, root, bases, deadline=..., max_records=...)`.
pub fn retirement(
    candidate: &Path,
    root: &Path,
    bases: &[LeaseBase],
    deadline: Instant,
    max_records: NonZeroUsize,
    paths: &mut dyn RetirementPaths,
) -> Result<Retirement> {
    let canonical = |path: &Path| std::fs::canonicalize(path).is_ok_and(|real| real == path);
    let symlink = candidate
        .symlink_metadata()
        .is_ok_and(|info| info.file_type().is_symlink());
    if !candidate.is_absolute()
        || !canonical(candidate)
        || symlink
        || !candidate.is_dir()
        || !candidate.starts_with(root)
        || !canonical(root)
    {
        return Err(LeaseError::unknown(
            "canonical retirement lease root required",
        ));
    }
    let ancestors = ancestor_keys(candidate, root)?;
    let mut ordered = bases.to_vec();
    ordered.sort_by(|left, right| left.path().as_os_str().cmp(right.path().as_os_str()));
    ordered.dedup();
    if ordered.is_empty() || ordered.len() != bases.len() {
        return Err(LeaseError::unknown(
            "retirement lease inventory unavailable",
        ));
    }
    let mut held = Vec::with_capacity(ordered.len());
    let mut barriers = Vec::with_capacity(ordered.len());
    for base in ordered {
        deadline_check(deadline)?;
        let directory = native::open_at(
            libc::AT_FDCWD,
            base.path().as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let stamp = stamp(&directory.metadata()?);
        barriers.push(barrier(&base, true, Duration::ZERO)?);
        held.push(HeldBase {
            base,
            directory,
            stamp,
        });
    }
    let mut inventory = Inventory {
        candidate,
        root,
        ancestors,
        deadline,
        max_records: max_records.get(),
        registered: 0,
        relevant: 0,
        kept: Vec::new(),
        paths,
    };
    for base in &held {
        inventory.base(base)?;
    }
    validate_bases(&held, deadline)?;
    Ok(Retirement {
        summary: RetirementSummary {
            registered_records: inventory.registered,
            relevant_keys: inventory.relevant,
        },
        deadline,
        bases: held,
        _locks: inventory.kept,
        _barriers: barriers,
    })
}

fn ancestor_keys(candidate: &Path, root: &Path) -> Result<Vec<String>> {
    let mut keys = Vec::new();
    let mut parent = candidate;
    loop {
        keys.push(key_of(parent)?.ok_or_else(|| {
            LeaseError::unknown(format!("No such file or directory: {}", parent.display()))
        })?);
        if parent == root {
            return Ok(keys);
        }
        parent = parent.parent().unwrap_or(root);
    }
}

fn stamp(info: &std::fs::Metadata) -> (u64, u64, u32, u32) {
    (info.dev(), info.ino(), info.uid(), info.mode())
}

fn validate_bases(bases: &[HeldBase], deadline: Instant) -> Result<()> {
    deadline_check(deadline)?;
    for held in bases {
        let path = held.base.path();
        let current = std::fs::symlink_metadata(path)?;
        let same = stamp(&held.directory.metadata()?) == held.stamp
            && stamp(&current) == held.stamp
            && std::fs::canonicalize(path).is_ok_and(|real| real == path);
        if !same {
            return Err(LeaseError::unknown("retirement lease directory changed"));
        }
    }
    Ok(())
}

struct Inventory<'a> {
    candidate: &'a Path,
    root: &'a Path,
    ancestors: Vec<String>,
    deadline: Instant,
    max_records: usize,
    registered: usize,
    relevant: usize,
    kept: Vec<Flock<File>>,
    paths: &'a mut dyn RetirementPaths,
}

impl Inventory<'_> {
    /// List one base by its held descriptor and group names by key.
    fn base(&mut self, held: &HeldBase) -> Result<()> {
        let listing = format!("/proc/self/fd/{}", held.directory.as_raw_fd());
        let mut grouped: Vec<(String, Names)> = Vec::new();
        for entry in std::fs::read_dir(listing)? {
            deadline_check(self.deadline)?;
            self.registered += 1;
            if self.registered > self.max_records {
                return Err(LeaseError::unknown(
                    "retirement lease inventory bound exhausted",
                ));
            }
            let name = entry?.file_name().as_bytes().to_vec();
            if name == b"barrier.lock" {
                continue;
            }
            let (key, kind) = classify(&name)
                .ok_or_else(|| LeaseError::unknown("retirement lease inventory malformed"))?;
            match grouped.iter_mut().find(|(known, _)| *known == key) {
                Some((_, names)) => names.push((name, kind)),
                None => grouped.push((key, vec![(name, kind)])),
            }
        }
        grouped.sort_by(|left, right| left.0.cmp(&right.0));
        for (key, names) in grouped {
            deadline_check(self.deadline)?;
            self.key(held, &key, &names)?;
        }
        Ok(())
    }

    fn key(&mut self, held: &HeldBase, key: &str, names: &Names) -> Result<()> {
        let mut records = Vec::new();
        for (name, kind) in names.iter().filter(|(_, kind)| *kind != Kind::Lock) {
            records.push((*kind, read_record(&held.directory, name)?));
        }
        let reservation = records
            .iter()
            .find(|(kind, _)| *kind == Kind::Reserve)
            .map_or(ReservationState::Free, |(_, record)| {
                record.reservation_state(now())
            });
        if reservation == ReservationState::Unknown {
            return Err(LeaseError::unknown("retirement reservation is malformed"));
        }
        let (lock, held_elsewhere) = if names.iter().any(|(_, kind)| *kind == Kind::Lock) {
            probe_lock(&held.directory, key, held.stamp.2)?
        } else {
            (None, false)
        };
        let active = held_elsewhere || reservation == ReservationState::InUse;
        if active && records.is_empty() {
            return Err(LeaseError::unknown(
                "active retirement lease has no path evidence",
            ));
        }
        let mut relevant = self.ancestors.iter().any(|known| known == key);
        for (_, record) in &records {
            relevant |= self.registered_path(record, key, active)?;
        }
        if relevant {
            self.relevant += 1;
            if active {
                return Err(LeaseError::in_use(
                    "temporary tree has a live registered lease or reservation",
                ));
            }
            self.kept.extend(lock);
        }
        Ok(())
    }

    /// Validate one registered path and report whether it is related.
    fn registered_path(&mut self, record: &LeaseRecord, key: &str, active: bool) -> Result<bool> {
        let path = registered_path(record.path())?;
        let mut relevant = self.relates(&path);
        if !active {
            return Ok(relevant);
        }
        let physicals = self.paths.physical(&path, key)?;
        if physicals.is_empty() || physicals.len() > PHYSICAL_PATHS {
            return Err(LeaseError::unknown(
                "active retirement lease path cannot be resolved",
            ));
        }
        for physical in physicals {
            let canonical = std::fs::canonicalize(&physical).is_ok_and(|real| real == physical);
            if !canonical || key_of(&physical)?.as_deref() != Some(key) {
                return Err(LeaseError::unknown("active retirement lease path changed"));
            }
            relevant |= self.relates(&physical) || self.paths.related(&physical)?;
        }
        Ok(relevant)
    }

    fn relates(&self, path: &Path) -> bool {
        path.starts_with(self.candidate)
            || (self.candidate.starts_with(path) && path.starts_with(self.root))
    }
}

/// The registered `path` must be a pathlib-normal absolute UTF-8 string of
/// at most 4096 bytes, without NUL or `..`. A `//`-rooted name is refused:
/// pathlib and Rust disagree about its relations.
fn registered_path(points: Option<&[u32]>) -> Result<PathBuf> {
    let refused = || LeaseError::unknown("retirement registered path unavailable");
    let name = points
        .ok_or_else(refused)?
        .iter()
        .map(|point| char::from_u32(*point))
        .collect::<Option<String>>()
        .ok_or_else(refused)?;
    let rest = name.strip_prefix('/').ok_or_else(refused)?;
    let normal = rest.is_empty()
        || rest
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if name.len() > PATH_BYTES || name.contains('\0') || !normal {
        return Err(refused());
    }
    Ok(PathBuf::from(name))
}

/// `_retirement_record`: bounded, pinned lease metadata; no symlink or
/// special-file payload reads.
fn read_record(directory: &File, name: &[u8]) -> Result<LeaseRecord> {
    let unavailable = || LeaseError::unknown("retirement lease metadata unavailable");
    let mut file = native::open_at(
        directory.as_raw_fd(),
        OsStr::from_bytes(name),
        libc::O_RDONLY | libc::O_NONBLOCK,
    )?;
    let before = file.metadata().map_err(|_| unavailable())?;
    let owner = directory.metadata().map_err(|_| unavailable())?.uid();
    if !before.is_file()
        || before.uid() != owner
        || before.mode() & 0o022 != 0
        || before.nlink() != 1
        || before.size() > RECORD_BYTES
    {
        return Err(unavailable());
    }
    let mut raw = Vec::new();
    (&mut file)
        .take(RECORD_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| unavailable())?;
    if raw.len() as u64 > RECORD_BYTES {
        return Err(LeaseError::unknown(
            "retirement lease metadata bound exhausted",
        ));
    }
    let after = file.metadata().map_err(|_| unavailable())?;
    let current = nix::sys::stat::fstatat(
        directory,
        OsStr::from_bytes(name),
        AtFlags::AT_SYMLINK_NOFOLLOW,
    )
    .map_err(|_| unavailable())?;
    let pinned = |info: &std::fs::Metadata| {
        (
            info.dev(),
            info.ino(),
            info.size(),
            nanos(info.mtime(), info.mtime_nsec()),
            nanos(info.ctime(), info.ctime_nsec()),
        )
    };
    #[allow(clippy::cast_sign_loss)]
    let named = (
        current.st_dev as u64,
        current.st_ino as u64,
        current.st_size as u64,
        nanos(current.st_mtime, current.st_mtime_nsec),
        nanos(current.st_ctime, current.st_ctime_nsec),
    );
    if pinned(&before) != pinned(&after)
        || pinned(&after) != named
        || raw.len() as u64 != before.size()
    {
        return Err(LeaseError::unknown("retirement lease metadata changed"));
    }
    LeaseRecord::parse(&raw).map_err(|error| match error {
        LeaseRecordError::Duplicate => LeaseError::unknown("duplicate retirement lease metadata"),
        LeaseRecordError::Invalid => unavailable(),
        LeaseRecordError::Malformed => LeaseError::unknown("retirement lease metadata malformed"),
    })
}

fn nanos(seconds: i64, nanoseconds: i64) -> i128 {
    i128::from(seconds) * 1_000_000_000 + i128::from(nanoseconds)
}

/// `_retirement_probe_lock`: an owner-private single-link regular lock; a
/// held lock reads as active, and a free one comes back locked.
fn probe_lock(directory: &File, key: &str, owner: u32) -> Result<(Option<Flock<File>>, bool)> {
    let file = native::open_at(
        directory.as_raw_fd(),
        OsStr::new(&format!("{key}.lock")),
        libc::O_RDWR,
    )?;
    let info = file.metadata()?;
    if !info.is_file() || info.uid() != owner || info.mode() & 0o077 != 0 || info.nlink() != 1 {
        return Err(LeaseError::unknown("retirement lease lock unavailable"));
    }
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Ok((Some(lock), false)),
        Err((_, nix::errno::Errno::EWOULDBLOCK)) => Ok((None, true)),
        Err((_, error)) => Err(error.into()),
    }
}
