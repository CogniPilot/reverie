//! Actual cold TMP filesystem owners, used only through LaunchStorage's fixed
//! lifecycle. Path/configuration data alone never enables a transaction.
mod admission;
mod clear;
mod directories;
mod leases;
mod lifecycle;
pub(super) use lifecycle::Lifecycle;
#[cfg(test)]
mod leases_tests;
mod references;
pub(in crate::worker_storage) mod retained;
#[cfg(test)]
mod tests;
mod tree;
use super::*;
#[cfg(test)]
pub(super) use admission::Admission;
#[cfg(test)]
pub(super) use clear::FAIL_FINALIZER;
#[cfg(test)]
pub(super) use clear::run as clear_transaction;
use std::{
    collections::BTreeSet,
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStringExt, fs::MetadataExt},
    },
    time::Instant,
};
const MAX_ENTRIES: usize = 4096;
const MAX_BYTES: u64 = 2 << 30;
type Key = (u64, u64);
#[derive(Clone, Debug, Eq, PartialEq)]
struct Stamp {
    key: Key,
    mode: u32,
    uid: u32,
    links: u64,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl Stamp {
    fn capture(info: &std::fs::Metadata) -> Self {
        Self {
            key: (info.dev(), info.ino()),
            mode: info.mode(),
            uid: info.uid(),
            links: info.nlink(),
            size: info.size(),
            modified: (info.mtime(), info.mtime_nsec()),
            changed: (info.ctime(), info.ctime_nsec()),
        }
    }
    fn directory(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFDIR
    }
    fn same_directory(&self, other: &Self) -> bool {
        self.key == other.key && self.mode == other.mode && self.uid == other.uid
    }
}
fn check(end: Instant) -> Result<()> {
    need(Instant::now() < end, StorageFault::ColdDeadline)
}
fn mount(file: &File) -> Result<reverie_core::decimal::UnsignedInteger> {
    let raw = native::read_reservation(
        &PathBuf::from(format!("/proc/self/fdinfo/{}", file.as_raw_fd())),
        65536,
    )?;
    let raw =
        std::str::from_utf8(&raw).map_err(|_| StorageError::Refused(StorageFault::ColdMount))?;
    reverie_contracts::kernel_accounting::mount_id(raw)
        .map_err(|_| StorageError::Refused(StorageFault::ColdMount))
}
fn names(file: &File, remaining: usize, end: Instant) -> Result<Vec<OsString>> {
    // scandir(fd) uses Python surrogateescape; raw byte order differs for
    // invalid UTF8 versus non-BMP scalar names.
    let mut names = raw_names(file, remaining, end)?;
    names.sort_by_key(|name| native::python_text(Path::new(name)));
    Ok(names)
}
fn raw_names(file: &File, remaining: usize, end: Instant) -> Result<Vec<OsString>> {
    let names = reverie_store::worker_storage::cold_directory_names(file, remaining, end)
        .map_err(StorageError::ColdFilesystem)?;
    let names = names
        .into_iter()
        .map(OsString::from_vec)
        .collect::<Vec<_>>();
    Ok(names)
}
