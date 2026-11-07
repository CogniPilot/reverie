//! Memory's pinned CPython 3.13.15 list-sort policy. NaN keys make the exact
//! run/merge schedule observable; a different stable sorter is not equivalent.
//! Derived from CPython Objects/listobject.c; see PYTHON_SORT_LICENSE.txt.
mod gallop;
mod merge;
mod runs;
use std::fmt;
#[derive(Clone, Copy, Debug)]
pub struct MemoryRank {
    pub score: f64,
    pub created_at: f64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MemoryRankError;
impl fmt::Display for MemoryRankError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "memory ranking allocation failed")
    }
}
impl std::error::Error for MemoryRankError {}
#[derive(Clone, Copy)]
struct Run {
    start: usize,
    len: usize,
    power: usize,
}
struct Sorter<'a> {
    keys: &'a [MemoryRank],
    order: Vec<usize>,
    buffer: Vec<usize>,
    pending: Vec<Run>,
    min_gallop: usize,
}
impl Sorter<'_> {
    fn less(&self, left: usize, right: usize) -> bool {
        let left = self.keys[left];
        let right = self.keys[right];
        // Python's tuple (-score,-created_at) compares the second component
        // only after equality, never after unordered NaN comparisons.
        if left.score == right.score {
            left.created_at > right.created_at
        } else {
            left.score > right.score
        }
    }
    fn merge_at(&mut self, index: usize) {
        let first = self.pending[index];
        let second = self.pending[index + 1];
        self.pending[index].len += second.len;
        self.pending.remove(index + 1);
        let skipped = self.gallop_right(
            self.order[second.start],
            &self.order[first.start..first.start + first.len],
            0,
        );
        let start = first.start + skipped;
        let left = first.len - skipped;
        if left == 0 {
            return;
        }
        let right = self.gallop_left(
            self.order[start + left - 1],
            &self.order[second.start..second.start + second.len],
            second.len - 1,
        );
        if right == 0 {
            return;
        }
        if left <= right {
            self.merge_lo(start, left, right);
        } else {
            self.merge_hi(start, left, right);
        }
    }
    fn new_run(&mut self, start: usize, len: usize) {
        if let Some(previous) = self.pending.last().copied() {
            let power = runs::power(previous.start, previous.len, len, self.order.len());
            while self.pending.len() > 1 && self.pending[self.pending.len() - 2].power > power {
                self.merge_at(self.pending.len() - 2);
            }
            self.pending.last_mut().expect("nonempty run stack").power = power;
        }
        self.pending.push(Run {
            start,
            len,
            power: 0,
        });
    }
    fn sort(&mut self) {
        let minrun = runs::minrun(self.order.len());
        let mut start = 0;
        while start < self.order.len() {
            let mut length = self.count_run(start);
            let force = minrun.min(self.order.len() - start);
            if length < force {
                self.binary_sort(start, force, length);
                length = force;
            }
            self.new_run(start, length);
            start += length;
        }
        while self.pending.len() > 1 {
            let mut index = self.pending.len() - 2;
            if index > 0 && self.pending[index - 1].len < self.pending[index + 1].len {
                index -= 1;
            }
            self.merge_at(index);
        }
    }
}
/// Input order is the database's actual candidate order; no extra ID tie key.
pub fn memory_rank_order(keys: &[MemoryRank]) -> Result<Vec<usize>, MemoryRankError> {
    let mut order = Vec::new();
    order
        .try_reserve_exact(keys.len())
        .map_err(|_| MemoryRankError)?;
    order.extend(0..keys.len());
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(keys.len().div_ceil(2))
        .map_err(|_| MemoryRankError)?;
    let mut pending = Vec::new();
    pending
        .try_reserve_exact(usize::BITS as usize + 1)
        .map_err(|_| MemoryRankError)?;
    let mut sorter = Sorter {
        keys,
        order,
        buffer,
        pending,
        min_gallop: 7,
    };
    sorter.sort();
    Ok(sorter.order)
}
