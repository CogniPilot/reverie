//! The destructive janitor's exclusive hold (`janitor`) and `check`.
use super::{
    CheckState, LeaseBase, LeaseCode, LeaseError, ReservationState, Result, abspath, barrier,
    key_of, malformed_metadata, open, reservation_state,
};
use nix::fcntl::{Flock, FlockArg};
use std::fs::File;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Bounds for the descendant inventory; both limits or neither, by construction.
#[derive(Clone, Copy, Debug)]
pub struct WalkBound {
    pub max_entries: NonZeroUsize,
    pub deadline: Instant,
}

/// Everything that makes deleting the candidate safe, held until drop:
/// every exclusive barrier and every existing related lock.
pub struct Janitor {
    own: Vec<String>,
    _locks: Vec<Flock<File>>,
    _barriers: Vec<super::Barrier>,
}
impl Janitor {
    /// Keys of the candidate and its descendants, in walk order.
    #[must_use]
    pub fn own_keys(&self) -> &[String] {
        &self.own
    }
}

/// `janitor`: take every barrier exclusive (non-blocking) in sorted path
/// order, then refuse a live or malformed reservation and lock every
/// existing lock of the candidate, its descendants and its ancestors up to
/// `root`. No lock file is created. Delete only while this is held.
pub fn janitor(
    candidate: &Path,
    root: Option<&Path>,
    bases: &[LeaseBase],
    bound: Option<WalkBound>,
) -> Result<Janitor> {
    let real = candidate.symlink_metadata().is_ok_and(|info| info.is_dir());
    if !real {
        return Err(LeaseError::unknown(format!(
            "candidate must be a real directory: {}",
            candidate.display()
        )));
    }
    if bases.is_empty() {
        return Err(LeaseError::unknown(
            "a janitor needs at least one lease dir",
        ));
    }
    let mut ordered = bases.to_vec();
    ordered.sort_by(|left, right| left.path().as_os_str().cmp(right.path().as_os_str()));
    let mut barriers = Vec::with_capacity(ordered.len());
    for base in &ordered {
        barriers.push(barrier(base, true, Duration::ZERO)?);
    }
    let (own, ancestors) = keys_for(candidate, root, bound)?;
    let mut keys = own.iter().chain(&ancestors).cloned().collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    for base in &ordered {
        for key in &keys {
            let at = base.path().join(key);
            match reservation_state(base, key) {
                ReservationState::Free => {}
                ReservationState::Unknown => {
                    return Err(LeaseError::unknown(format!(
                        "malformed or out-of-bounds reservation: {}",
                        at.display()
                    )));
                }
                ReservationState::InUse => {
                    return Err(LeaseError::in_use(format!("reserved: {}", at.display())));
                }
            }
        }
    }
    let mut locks = Vec::new();
    for base in &ordered {
        for key in &keys {
            if let Some(lock) = exclusive_lock(base, key)? {
                locks.push(lock);
            }
        }
    }
    Ok(Janitor {
        own,
        _locks: locks,
        _barriers: barriers,
    })
}

fn exclusive_lock(base: &LeaseBase, key: &str) -> Result<Option<Flock<File>>> {
    let path = base.path().join(format!("{key}.lock"));
    if !path.exists() {
        return Ok(None);
    }
    let at = base.path().join(key);
    if malformed_metadata(base, key)? {
        return Err(LeaseError::unknown(format!(
            "malformed lease metadata: {}",
            at.display()
        )));
    }
    let file = open(&path, libc::O_RDWR)?;
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Ok(Some(lock)),
        Err((_, nix::errno::Errno::EWOULDBLOCK)) => {
            Err(LeaseError::in_use(format!("leased: {}", at.display())))
        }
        Err((_, error)) => Err(error.into()),
    }
}

/// `check`: exactly the janitor's test, without deleting. A busy barrier
/// means skip this pass (in use), as in the reference model.
#[must_use]
pub fn check(candidate: &Path, root: Option<&Path>, bases: &[LeaseBase]) -> (CheckState, String) {
    if candidate
        .symlink_metadata()
        .is_ok_and(|info| info.file_type().is_symlink())
    {
        return (CheckState::Unknown, "candidate is a symlink".into());
    }
    match janitor(candidate, root, bases, None) {
        Ok(_held) => (CheckState::Free, "free".into()),
        Err(error) if error.code() == LeaseCode::Unknown => (CheckState::Unknown, error.message),
        Err(error) => (CheckState::InUse, error.message),
    }
}

/// `_keys_for`: the candidate and its descendants (no symlinks followed),
/// then its ancestors up to `root` (or `/`).
fn keys_for(
    candidate: &Path,
    root: Option<&Path>,
    bound: Option<WalkBound>,
) -> Result<(Vec<String>, Vec<String>)> {
    let candidate = abspath(candidate)?;
    let own = match bound {
        None => walk(&candidate)?,
        Some(bound) => bounded_walk(&candidate, bound)?,
    };
    let stop = match root {
        Some(root) => abspath(root)?,
        None => PathBuf::from("/"),
    };
    let mut ancestors = Vec::new();
    let mut parent = candidate.parent().unwrap_or(&candidate).to_path_buf();
    loop {
        ancestors.push(stat_key(&parent)?);
        match parent.parent() {
            Some(next) if parent != stop => parent = next.to_path_buf(),
            _ => break,
        }
    }
    Ok((own, ancestors))
}

/// A key that must exist: a vanished part of the tree is UNKNOWN.
fn stat_key(path: &Path) -> Result<String> {
    key_of(path)?.ok_or_else(|| {
        LeaseError::unknown(format!(
            "cannot stat part of the tree: {}: not found",
            path.display()
        ))
    })
}

fn unreadable(error: &std::io::Error) -> LeaseError {
    LeaseError::unknown(format!("cannot read part of the tree: {error}"))
}

/// `os.walk(followlinks=False)` top-down: an unlistable or vanished subtree
/// may hide a lease, so the answer is UNKNOWN (r9 N2).
fn walk(candidate: &Path) -> Result<Vec<String>> {
    let mut keys = Vec::new();
    let mut pending = vec![candidate.to_path_buf()];
    while let Some(current) = pending.pop() {
        let entries = std::fs::read_dir(&current).map_err(|error| unreadable(&error))?;
        let mut children = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| unreadable(&error))?;
            // os.walk recurses into real directories only; errors read as "not a directory".
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                children.push(entry.path());
            }
        }
        keys.push(stat_key(&current)?);
        pending.extend(children.into_iter().rev());
    }
    Ok(keys)
}

/// The bounded inventory: every listed entry counts toward `max_entries`.
fn bounded_walk(candidate: &Path, bound: WalkBound) -> Result<Vec<String>> {
    let exhausted = || LeaseError::unknown("lease inventory bound exhausted");
    let mut keys = Vec::new();
    let mut pending = vec![candidate.to_path_buf()];
    let mut visited = 0usize;
    while let Some(current) = pending.pop() {
        if Instant::now() >= bound.deadline {
            return Err(LeaseError::unknown("lease inventory deadline exhausted"));
        }
        keys.push(stat_key(&current)?);
        let stat_error = |error: std::io::Error| {
            LeaseError::unknown(format!("cannot stat part of the tree: {error}"))
        };
        for entry in std::fs::read_dir(&current).map_err(stat_error)? {
            let entry = entry.map_err(stat_error)?;
            visited += 1;
            if visited > bound.max_entries.get() || Instant::now() >= bound.deadline {
                return Err(exhausted());
            }
            if entry.file_type().map_err(stat_error)?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(keys)
}
