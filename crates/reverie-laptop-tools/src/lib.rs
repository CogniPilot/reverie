//! Native laptop defaults shared by the packaged command-line entrypoints.
use std::path::Path;

mod cargo;
mod fs;
pub use cargo::{MergeError, MergeOutcome, merge_cargo_defaults};

/// Conservative parallelism based on finite in-laptop cgroup thresholds.
/// An explicit owner job count is handled by the existing launcher shim.
pub fn build_jobs(cgroup_root: &Path, cpu_count: usize) -> usize {
    let limits = ["memory.max", "memory.high"]
        .into_iter()
        .filter_map(|name| {
            std::fs::read_to_string(cgroup_root.join(name))
                .ok()?
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|value| *value > 0)
        });
    let gib = 1_u64 << 30;
    let jobs = limits
        .min()
        .map_or(1, |limit| limit.saturating_sub(gib) / gib)
        .max(1);
    usize::try_from(jobs)
        .unwrap_or(usize::MAX)
        .min(cpu_count.max(1))
}

#[cfg(test)]
mod tests;
