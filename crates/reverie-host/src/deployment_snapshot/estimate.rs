//! Size the console before stopping anything. This reads names and sizes
//! only, while the console may still be writing; it is a planning figure and
//! establishes nothing about the later verified copy.
use super::{Result, deadline, manifest, require};
use std::{
    fs, io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Instant,
};

/// One archive member: its header, an extended header with its records, and
/// the padding of its content to a whole block.
const ARCHIVE_ENTRY_BYTES: u64 = 4096;
/// One file-system block for each restored entry's metadata and tail.
const RESTORED_ENTRY_BYTES: u64 = 4096;
const ARCHIVE_TRAILER_BYTES: u64 = 1 << 20;
/// A verified capture and restore rehearsal reads the console eight times,
/// the archive nine times and the restored copy twice. See `stage_console`
/// and `rehearse_at`: each source check hashes the console twice and compares
/// it with the archive once, between two archive digests.
const SOURCE_READS: u64 = 8;
const ARCHIVE_READS: u64 = 9;
const RESTORED_READS: u64 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConsoleEstimate {
    entries: u64,
    regular_bytes: u64,
}
impl ConsoleEstimate {
    pub fn entries(&self) -> u64 {
        self.entries
    }
    pub fn regular_bytes(&self) -> u64 {
        self.regular_bytes
    }
    /// Space the uncompressed archive needs.
    pub fn archive_bytes(&self) -> u64 {
        self.regular_bytes
            .saturating_add(self.entries.saturating_mul(ARCHIVE_ENTRY_BYTES))
            .saturating_add(ARCHIVE_TRAILER_BYTES)
    }
    /// Space the extracted restore rehearsal needs.
    pub fn rehearsal_bytes(&self) -> u64 {
        self.regular_bytes
            .saturating_add(self.entries.saturating_mul(RESTORED_ENTRY_BYTES))
    }
    /// Bytes written while the console is stopped.
    pub fn stopped_write_bytes(&self) -> u64 {
        self.archive_bytes().saturating_add(self.rehearsal_bytes())
    }
    /// Bytes read back while the console is stopped, across every check.
    pub fn stopped_read_bytes(&self) -> u64 {
        self.regular_bytes
            .saturating_mul(SOURCE_READS + RESTORED_READS)
            .saturating_add(self.archive_bytes().saturating_mul(ARCHIVE_READS))
    }
}

/// `source` is the host bind root holding the `console` directory. Entries
/// that disappear during the walk are skipped. The entry and depth bounds are
/// those the verified capture enforces, so a console it would refuse is
/// refused here first.
pub fn estimate_console(source: &Path, end: Instant) -> Result<ConsoleEstimate> {
    let mut estimate = ConsoleEstimate {
        entries: 0,
        regular_bytes: 0,
    };
    let root = fs::canonicalize(source)?.join("console");
    require(
        fs::symlink_metadata(&root)?.is_dir(),
        "SNAPSHOT_DIRECTORY_CHANGED",
    )?;
    let mut pending = vec![(root, 1_usize)];
    while let Some((path, depth)) = pending.pop() {
        deadline(end)?;
        let Some(info) = present(fs::symlink_metadata(&path))? else {
            continue;
        };
        estimate.entries += 1;
        require(
            estimate.entries <= manifest::MAX_ENTRIES as u64,
            "SNAPSHOT_ENTRY_BOUND",
        )?;
        require(depth <= manifest::MAX_DEPTH, "SNAPSHOT_DEPTH_BOUND")?;
        if info.is_file() {
            estimate.regular_bytes = estimate.regular_bytes.saturating_add(info.size());
        } else if info.is_dir() {
            children(&path, depth + 1, &mut pending)?;
        }
    }
    Ok(estimate)
}
fn children(path: &Path, depth: usize, pending: &mut Vec<(PathBuf, usize)>) -> Result<()> {
    let Some(entries) = present(fs::read_dir(path))? else {
        return Ok(());
    };
    for entry in entries {
        if let Some(entry) = present(entry)? {
            pending.push((entry.path(), depth));
        }
    }
    Ok(())
}
/// A running console removes files; only that is tolerated.
fn present<T>(result: io::Result<T>) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
