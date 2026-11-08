//! Reads the seat's memory facts and a process tree's usage. Roots are parameters so tests can
//! supply fake trees; in use they are `/sys/fs/cgroup` and `/proc`.
use crate::rule::Facts;
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

/// Bound on the processes walked for one job's tree.
const MAX_TREE: usize = 4096;

#[derive(Clone, Debug)]
pub struct Roots {
    pub cgroup: PathBuf,
    pub proc: PathBuf,
}

/// Why the facts could not be read. The gate refuses rather than guess.
#[derive(Debug, PartialEq, Eq)]
pub struct Unreadable(pub String);

pub fn read_facts(roots: &Roots) -> Result<Facts, Unreadable> {
    let max_text = read(&roots.cgroup.join("memory.max"))?;
    let max = match max_text.trim() {
        "max" => mem_total(&roots.proc)?,
        value => value
            .parse()
            .map_err(|_| Unreadable(format!("memory.max is not a number: {value}")))?,
    };
    let stat = read(&roots.cgroup.join("memory.stat"))?;
    Ok(Facts {
        max,
        anon: stat_field(&stat, "anon")?,
        kernel: stat_field(&stat, "kernel")?,
        sock: stat_field(&stat, "sock")?,
    })
}

fn read(path: &Path) -> Result<String, Unreadable> {
    fs::read_to_string(path).map_err(|e| Unreadable(format!("{}: {e}", path.display())))
}

fn stat_field(stat: &str, name: &str) -> Result<u64, Unreadable> {
    stat.lines()
        .filter_map(|line| line.split_once(' '))
        .find(|(key, _)| *key == name)
        .and_then(|(_, value)| value.trim().parse().ok())
        .ok_or_else(|| Unreadable(format!("memory.stat has no {name}")))
}

fn mem_total(proc: &Path) -> Result<u64, Unreadable> {
    let meminfo = read(&proc.join("meminfo"))?;
    kib_field(&meminfo, "MemTotal:").ok_or_else(|| Unreadable("meminfo has no MemTotal".into()))
}

fn kib_field(text: &str, name: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with(name))?;
    let kib: u64 = line[name.len()..].split_whitespace().next()?.parse().ok()?;
    kib.checked_mul(1024)
}

/// What `/proc` says about a pid. Only `Gone` and a different `Started` prove a holder stale;
/// anything the gate cannot read is `Unknown`, and the caller must not treat it as gone.
#[derive(Debug, PartialEq, Eq)]
pub enum Process {
    Gone,
    /// The start time (clock ticks since boot, field 22 of `stat`); with the pid it names one
    /// process, so a reused pid is told apart.
    Started(u64),
    Unknown(String),
}

pub fn process(proc: &Path, pid: u32) -> Process {
    let path = proc.join(pid.to_string()).join("stat");
    match fs::read_to_string(&path) {
        // ENOENT: no such pid; ESRCH: it exited while being read.
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(nix::libc::ESRCH) =>
        {
            Process::Gone
        }
        Err(error) => Process::Unknown(format!("{}: {error}", path.display())),
        Ok(stat) => stat
            .rfind(')')
            .and_then(|end| stat[end + 1..].split_whitespace().nth(19)?.parse().ok())
            .map_or_else(
                || Process::Unknown(format!("{}: no start time", path.display())),
                Process::Started,
            ),
    }
}

pub fn start_time(proc: &Path, pid: u32) -> Option<u64> {
    match process(proc, pid) {
        Process::Started(start) => Some(start),
        Process::Gone | Process::Unknown(_) => None,
    }
}

/// Summed `Pss_Anon` over the process and all its descendants, or None if any of them could not
/// be read (the caller then counts the job at its reservation).
pub fn tree_pss_anon(proc: &Path, root: u32) -> Option<u64> {
    let mut seen = BTreeSet::new();
    let mut queue = vec![root];
    let mut total = 0u64;
    while let Some(pid) = queue.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if seen.len() > MAX_TREE {
            return None;
        }
        let rollup = fs::read_to_string(proc.join(pid.to_string()).join("smaps_rollup")).ok()?;
        total = total.saturating_add(kib_field(&rollup, "Pss_Anon:")?);
        queue.extend(children(proc, pid)?);
    }
    Some(total)
}

fn children(proc: &Path, pid: u32) -> Option<Vec<u32>> {
    let mut out = Vec::new();
    for task in fs::read_dir(proc.join(pid.to_string()).join("task")).ok()? {
        let list = fs::read_to_string(task.ok()?.path().join("children")).ok()?;
        out.extend(
            list.split_whitespace()
                .filter_map(|id| id.parse::<u32>().ok()),
        );
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(max: &str, stat: &str) -> (tempdir::Dir, Roots) {
        let dir = tempdir::Dir::new();
        let cgroup = dir.path().join("cgroup");
        let proc = dir.path().join("proc");
        fs::create_dir_all(&cgroup).unwrap();
        fs::create_dir_all(&proc).unwrap();
        fs::write(cgroup.join("memory.max"), max).unwrap();
        fs::write(cgroup.join("memory.stat"), stat).unwrap();
        fs::write(proc.join("meminfo"), "MemTotal:       2048 kB\n").unwrap();
        (dir, Roots { cgroup, proc })
    }

    #[test]
    fn reads_the_cap_and_the_oom_relevant_fields() {
        let (_dir, roots) = fake("1610612736\n", "anon 100\nfile 900\nkernel 20\nsock 3\n");
        assert_eq!(
            read_facts(&roots),
            Ok(Facts {
                max: 1610612736,
                anon: 100,
                kernel: 20,
                sock: 3
            })
        );
    }

    #[test]
    fn an_unlimited_cgroup_falls_back_to_total_memory() {
        let (_dir, roots) = fake("max\n", "anon 1\nkernel 2\nsock 0\n");
        assert_eq!(read_facts(&roots).unwrap().max, 2048 * 1024);
    }

    #[test]
    fn a_missing_field_or_file_refuses() {
        let (_dir, roots) = fake("100\n", "anon 1\nsock 0\n");
        assert!(read_facts(&roots).is_err());
        let (_dir, roots) = fake("100\n", "anon 1\nkernel 2\nsock 0\n");
        fs::remove_file(roots.cgroup.join("memory.stat")).unwrap();
        assert!(read_facts(&roots).is_err());
        let (_dir, roots) = fake("lots\n", "anon 1\nkernel 2\nsock 0\n");
        assert!(read_facts(&roots).is_err());
    }

    #[test]
    fn sums_pss_anon_over_the_tree_and_gives_up_on_an_unreadable_member() {
        let (_dir, roots) = fake("100\n", "anon 1\nkernel 2\nsock 0\n");
        let proc = &roots.proc;
        for (pid, kib, kids) in [(10u32, 4, "11 12"), (11, 6, ""), (12, 1, "")] {
            let task = proc
                .join(pid.to_string())
                .join("task")
                .join(pid.to_string());
            fs::create_dir_all(&task).unwrap();
            fs::write(task.join("children"), kids).unwrap();
            fs::write(
                proc.join(pid.to_string()).join("smaps_rollup"),
                format!("Rss: 99 kB\nPss_Anon: {kib} kB\n"),
            )
            .unwrap();
        }
        assert_eq!(tree_pss_anon(proc, 10), Some(11 * 1024));
        fs::remove_file(proc.join("12").join("smaps_rollup")).unwrap();
        assert_eq!(tree_pss_anon(proc, 10), None);
    }

    #[test]
    fn reads_the_start_time_after_a_name_with_spaces_and_parentheses() {
        let (_dir, roots) = fake("100\n", "anon 1\nkernel 2\nsock 0\n");
        let pid = roots.proc.join("42");
        fs::create_dir_all(&pid).unwrap();
        let fields: Vec<String> = (3..=22).map(|n| n.to_string()).collect();
        fs::write(
            pid.join("stat"),
            format!("42 (a (b) c) {}", fields.join(" ")),
        )
        .unwrap();
        assert_eq!(start_time(&roots.proc, 42), Some(22));
    }

    #[test]
    fn only_a_missing_pid_is_gone_and_an_unparsable_stat_is_unknown() {
        let (_dir, roots) = fake("100\n", "anon 1\nkernel 2\nsock 0\n");
        assert_eq!(process(&roots.proc, 7), Process::Gone);
        fs::create_dir_all(roots.proc.join("7")).unwrap();
        fs::write(roots.proc.join("7/stat"), "7 (x) R 1").unwrap();
        assert!(matches!(process(&roots.proc, 7), Process::Unknown(_)));
        fs::remove_file(roots.proc.join("7/stat")).unwrap();
        fs::create_dir(roots.proc.join("7/stat")).unwrap();
        assert!(matches!(process(&roots.proc, 7), Process::Unknown(_)));
    }

    /// A temporary directory removed on drop, without a test-only dependency.
    mod tempdir {
        use std::path::{Path, PathBuf};
        pub(super) struct Dir(PathBuf);
        impl Dir {
            pub(super) fn new() -> Self {
                let n = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let path =
                    std::env::temp_dir().join(format!("job-gate-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
            pub(super) fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
