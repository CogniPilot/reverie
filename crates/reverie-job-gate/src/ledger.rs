//! The reservation ledger: one file per admitted job in a per-seat directory, guarded by an
//! exclusive flock on `lock` for every read-decide-write. A holder whose pid no longer names the
//! same process (gone, or reused with another start time) is stale and is removed under the lock.
//! An entry the gate cannot read, parse or check against `/proc` is kept, and admission refuses
//! until it can be classified: deleting it could free a live job's reservation.
use crate::{
    GateError,
    facts::{Process, process},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub pid: u32,
    pub start: u64,
    pub reservation: u64,
}

pub struct Ledger {
    dir: PathBuf,
}

/// Holds the ledger lock until dropped.
pub struct Locked {
    _lock: nix::fcntl::Flock<File>,
}

impl Ledger {
    pub fn open(dir: &Path) -> io::Result<Self> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        Ok(Self {
            dir: dir.to_path_buf(),
        })
    }

    pub fn lock(&self) -> io::Result<Locked> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(self.dir.join("lock"))?;
        // Blocks until the exclusive lock is held; dropping Locked releases it.
        let lock = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusive)
            .map_err(|(_, errno)| io::Error::from(errno))?;
        Ok(Locked { _lock: lock })
    }

    /// Live entries, after removing stale ones; refuses on any entry it cannot classify. Call
    /// with the lock held.
    pub fn live(&self, _held: &Locked, proc: &Path) -> Result<Vec<Entry>, GateError> {
        let mut live = Vec::new();
        for item in fs::read_dir(&self.dir)? {
            let path = item?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            match classify(&path, proc) {
                Holder::Live(entry) => live.push(entry),
                Holder::Stale => fs::remove_file(&path)?,
                Holder::Removed => {}
                Holder::Unknown(why) => {
                    return Err(GateError::UnknownHolder(format!(
                        "{}: {why}; remove it if no job holds it",
                        path.display()
                    )));
                }
            }
        }
        live.sort_by_key(|entry| entry.pid);
        Ok(live)
    }

    pub fn add(&self, _held: &Locked, entry: Entry) -> io::Result<()> {
        let bytes = serde_json::to_vec(&entry).map_err(io::Error::other)?;
        let tmp = self.dir.join(format!("{}.tmp", entry.pid));
        fs::write(&tmp, bytes)?;
        fs::rename(tmp, self.dir.join(format!("{}.json", entry.pid)))
    }

    pub fn remove(&self, _held: &Locked, pid: u32) -> io::Result<()> {
        match fs::remove_file(self.dir.join(format!("{pid}.json"))) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

enum Holder {
    Live(Entry),
    /// Proven gone, or its pid reused by another process.
    Stale,
    /// Removed by someone else between listing and reading (proven by `symlink_metadata`).
    Removed,
    Unknown(String),
}

fn classify(path: &Path, proc: &Path) -> Holder {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        // Gone only if the entry itself is: a dangling symlink also reads as NotFound, but still exists.
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                && fs::symlink_metadata(path)
                    .is_err_and(|missing| missing.kind() == io::ErrorKind::NotFound) =>
        {
            return Holder::Removed;
        }
        Err(error) => return Holder::Unknown(format!("unreadable ({error})")),
    };
    let entry: Entry = match serde_json::from_slice(&bytes) {
        Ok(entry) => entry,
        Err(error) => return Holder::Unknown(format!("not a reservation ({error})")),
    };
    // `remove` and `add` find an entry by its file name, so a mismatch is not ours to judge.
    if path.file_stem().and_then(|stem| stem.to_str()) != Some(entry.pid.to_string().as_str()) {
        return Holder::Unknown(format!("holds pid {} under another name", entry.pid));
    }
    match process(proc, entry.pid) {
        Process::Gone => Holder::Stale,
        Process::Started(start) if start == entry.start => Holder::Live(entry),
        Process::Started(_) => Holder::Stale,
        Process::Unknown(why) => {
            Holder::Unknown(format!("pid {} not checkable ({why})", entry.pid))
        }
    }
}
