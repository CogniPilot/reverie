//! Hash memoization DATA only. Current file custody is checked on every call;
//! a candidate cannot enter this cache until its entire descriptor batch closes.
use super::*;
use std::{collections::BTreeMap, path::PathBuf};
const MAX_ENTRIES: usize = 4096;
#[derive(Default)]
pub(in crate::website_facts) struct HashCache {
    entries: BTreeMap<PathBuf, Verified>,
}
#[derive(Eq, PartialEq)]
pub(in crate::website_facts) struct Verified {
    path: PathBuf,
    digest: JournalDigest,
    bytes: u64,
    stamps: [Stamp; 2],
}
impl Verified {
    pub(super) fn new(path: &Path, code: &CodeFile, stamps: [Stamp; 2]) -> Self {
        Self {
            path: path.to_owned(),
            digest: code.sha256.clone(),
            bytes: code.bytes,
            stamps,
        }
    }
    pub(super) fn stamps(&self) -> &[Stamp; 2] {
        &self.stamps
    }
}
impl HashCache {
    pub(super) fn contains(&self, candidate: &Verified) -> bool {
        self.entries.get(&candidate.path) == Some(candidate)
    }
    /// Called only after the shared checked batch finalizer has succeeded.
    pub(in crate::website_facts) fn publish(&mut self, candidate: Verified) {
        if self.entries.len() == MAX_ENTRIES && !self.entries.contains_key(&candidate.path) {
            self.entries.pop_first();
        }
        self.entries.insert(candidate.path.clone(), candidate);
    }
}
#[cfg(test)]
thread_local! {static READS:std::cell::Cell<usize>=const{std::cell::Cell::new(0)};}
#[cfg(test)]
pub(in crate::website_facts) fn observe_hash_read() {
    READS.with(|reads| reads.set(reads.get() + 1));
}
#[cfg(test)]
pub(in crate::website_facts) fn hash_reads() -> usize {
    READS.with(std::cell::Cell::get)
}
