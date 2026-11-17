use super::admission::Limits;
use nix::unistd::{SysconfVar, sysconf};
use std::{fs, path::Path};

#[derive(Clone, Copy)]
pub(super) struct Usage {
    pub(super) used: u64,
    pub(super) limit: Option<u64>,
}

fn limit(root: &Path, name: &str) -> Option<Option<u64>> {
    let text = fs::read_to_string(root.join(name)).ok()?;
    match text.trim() {
        "max" => Some(None),
        value => Some(Some(value.parse().ok()?)),
    }
}

fn current(root: &Path, name: &str) -> Option<u64> {
    fs::read_to_string(root.join(name))
        .ok()?
        .trim()
        .parse()
        .ok()
}

pub(super) fn memory(root: &Path) -> Option<Usage> {
    let limit = limit(root, "memory.max")?;
    let current = current(root, "memory.current")?;
    let stat = fs::read_to_string(root.join("memory.stat")).ok()?;
    let mut inactive = 0;
    for entry in stat.lines().filter(|line| !line.trim().is_empty()) {
        let mut parts = entry.split_whitespace();
        let name = parts.next()?;
        let value = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        if name == "inactive_file" {
            inactive = value.parse().ok()?;
        }
    }
    Some(Usage {
        used: current.saturating_sub(inactive),
        limit,
    })
}

pub(super) fn pids(root: &Path) -> Option<Usage> {
    Some(Usage {
        used: current(root, "pids.current")?,
        limit: limit(root, "pids.max")?,
    })
}

pub(super) fn group_rss(root: &Path, group: i32, page_size: u64) -> u64 {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.parse::<u32>().is_ok())
        })
        .filter_map(|entry| resident_pages(&entry.path(), group))
        .fold(0_u64, u64::saturating_add)
        .saturating_mul(page_size)
}

fn resident_pages(path: &Path, group: i32) -> Option<u64> {
    let stat = fs::read_to_string(path.join("stat")).ok()?;
    let (_, tail) = stat.rsplit_once(')')?;
    if tail.split_whitespace().nth(2)?.parse::<i32>().ok()? != group {
        return None;
    }
    fs::read_to_string(path.join("statm"))
        .ok()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

pub(super) struct Samples {
    baseline_memory: Option<u64>,
    baseline_pids: Option<u64>,
    page_size: u64,
    pub(super) peak_tree: u64,
    pub(super) peak_cgroup_delta: Option<u64>,
    pub(super) peak_pids_delta: Option<u64>,
}

impl Samples {
    pub(super) fn capture(limits: &Limits) -> Self {
        let memory = memory(&limits.cgroup).map(|sample| sample.used);
        let pids = pids(&limits.cgroup).map(|sample| sample.used);
        let page_size = sysconf(SysconfVar::PAGE_SIZE)
            .ok()
            .flatten()
            .and_then(|value| u64::try_from(value).ok())
            .unwrap_or(4096);
        Self {
            baseline_memory: memory,
            baseline_pids: pids,
            page_size,
            peak_tree: 0,
            peak_cgroup_delta: memory.map(|_| 0),
            peak_pids_delta: pids.map(|_| 0),
        }
    }

    pub(super) fn measure(&mut self, limits: &Limits, group: i32) -> Option<Usage> {
        self.peak_tree = self
            .peak_tree
            .max(group_rss(&limits.proc, group, self.page_size));
        let memory = memory(&limits.cgroup);
        record_delta(&mut self.peak_cgroup_delta, self.baseline_memory, memory);
        record_delta(
            &mut self.peak_pids_delta,
            self.baseline_pids,
            pids(&limits.cgroup),
        );
        memory
    }
}

fn record_delta(peak: &mut Option<u64>, baseline: Option<u64>, sample: Option<Usage>) {
    if let (Some(peak), Some(baseline), Some(sample)) = (peak, baseline, sample) {
        *peak = (*peak).max(sample.used.saturating_sub(baseline));
    }
}
