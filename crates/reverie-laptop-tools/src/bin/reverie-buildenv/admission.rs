use super::{Build, GIB, MIB, observe, process::Stops};
use nix::sys::statvfs::statvfs;
use regex_lite::Regex;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, Instant},
};

const MEMORY_RESERVE: u64 = 512 * MIB;
const PIDS_RESERVE: u64 = 64;
const THREADS_BASE: u64 = 32;
const THREADS_PER_JOB: u64 = 16;
const RECHECK: Duration = Duration::from_secs(10);

pub(super) struct Limits {
    pub(super) cgroup: PathBuf,
    pub(super) proc: PathBuf,
    pub(super) disk_reserve: u64,
    pub(super) memory_headroom: u64,
    pub(super) sample_interval: Duration,
}

impl Limits {
    pub(super) fn system() -> Self {
        Self {
            cgroup: "/sys/fs/cgroup".into(),
            proc: "/proc".into(),
            disk_reserve: 20 * GIB,
            memory_headroom: 256 * MIB,
            sample_interval: Duration::from_millis(500),
        }
    }
}

static SIZE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)i?B?\s*$").unwrap());
static CHANNEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^\s*channel\s*=\s*"([^"]+)""#).unwrap());

pub(super) fn size(text: &str) -> Result<u64, String> {
    let invalid = || "size must look like 512M or 1.5G".to_owned();
    let m = SIZE.captures(text).ok_or_else(invalid)?;
    let value = m[1].parse::<f64>().map_err(|_| invalid())?;
    let shift = match m[2].to_ascii_uppercase().as_str() {
        "K" => 10,
        "M" => 20,
        "G" => 30,
        "T" => 40,
        _ => 0,
    };
    let bytes = value * ((1_u64 << shift) as f64);
    if !bytes.is_finite() || bytes >= u64::MAX as f64 {
        return Err("size exceeds the supported byte range".into());
    }
    Ok(bytes as u64)
}

pub(super) fn pinned_toolchain(repo: &Path) -> io::Result<Option<String>> {
    for name in ["rust-toolchain.toml", "rust-toolchain"] {
        let path = repo.join(name);
        if !path.is_file() {
            continue;
        }
        let text = fs::read_to_string(path)?;
        return Ok(CHANNEL
            .captures(&text)
            .map(|captures| captures[1].to_owned())
            .or_else(|| text.trim().lines().next().map(str::to_owned)));
    }
    Ok(None)
}

fn installed(cache: &Path, channel: &str) -> bool {
    let prefix = format!("{channel}-");
    fs::read_dir(cache.join("rustup/toolchains")).is_ok_and(|mut entries| {
        entries.any(|entry| {
            entry.is_ok_and(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(&prefix))
            })
        })
    })
}

struct Problem {
    message: String,
    transient: bool,
}
impl Problem {
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            transient: false,
        }
    }

    fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            transient: true,
        }
    }
}

fn valid_project(name: &str) -> bool {
    !name.is_empty()
        && !matches!(name, "." | "..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn memory_problem(build: &Build, limits: &Limits) -> Option<Problem> {
    let sample = observe::memory(&limits.cgroup)?;
    let limit = sample.limit?;
    let available = i128::from(limit) - i128::from(MEMORY_RESERVE) - i128::from(sample.used);
    (i128::from(build.expect) > available).then(|| {
        Problem::transient(format!(
            "memory: need {} MiB, {} MiB available below the {} MiB reserve",
            build.expect / MIB,
            available.max(0) / i128::from(MIB),
            MEMORY_RESERVE / MIB
        ))
    })
}

fn pids_problem(jobs: u8, root: &Path) -> Option<Problem> {
    let sample = observe::pids(root)?;
    let limit = sample.limit?;
    let need = THREADS_BASE + u64::from(jobs) * THREADS_PER_JOB;
    let slots = need + PIDS_RESERVE;
    if slots > limit {
        return Some(Problem::permanent(format!(
            "pids-limit: need ~{need} tasks for --jobs {jobs} plus {PIDS_RESERVE} reserved, but the cgroup allows only {limit}; lower --jobs or ask the owner to raise the container's --pids-limit"
        )));
    }
    (sample.used.saturating_add(slots) > limit).then(|| {
        Problem::transient(format!(
            "pids: need ~{need} tasks for --jobs {jobs}, {} of {limit} in use and {PIDS_RESERVE} reserved for other sessions; retry later (--wait), lower --jobs, or ask the owner to raise the container's --pids-limit",
            sample.used
        ))
    })
}

fn preflight(build: &Build, limits: &Limits) -> io::Result<Vec<Problem>> {
    if !valid_project(&build.cli.project) {
        return Ok(vec![Problem::permanent("project must be a plain name")]);
    }
    let mut problems = Vec::new();
    if let Some(channel) = pinned_toolchain(&build.repo)?
        && !installed(&build.cache, &channel)
    {
        problems.push(Problem::permanent(format!(
            "pinned toolchain {channel} is not installed in {}; install it deliberately",
            build.cache.display()
        )));
    }
    problems.extend(memory_problem(build, limits));
    problems.extend(pids_problem(build.cli.jobs, &limits.cgroup));
    let fs = statvfs(build.scratch.as_path()).map_err(io::Error::from)?;
    let free = fs.blocks_available().saturating_mul(fs.fragment_size());
    if free < build.cli.disk.saturating_add(limits.disk_reserve) {
        problems.push(Problem::transient(format!(
            "disk: need {:.1} GiB, {:.1} GiB free, {:.0} GiB reserve",
            build.cli.disk as f64 / GIB as f64,
            free as f64 / GIB as f64,
            limits.disk_reserve as f64 / GIB as f64
        )));
    }
    Ok(problems)
}

pub(super) async fn queue(
    build: &Build,
    limits: &Limits,
    queued: Instant,
    stop: &mut Stops,
) -> io::Result<Vec<String>> {
    let max_wait = Duration::from_secs(build.cli.wait);
    loop {
        let problems = preflight(build, limits)?;
        let remaining = max_wait.saturating_sub(queued.elapsed());
        if problems.is_empty()
            || problems.iter().any(|problem| !problem.transient)
            || remaining.is_zero()
        {
            return Ok(problems
                .into_iter()
                .map(|problem| problem.message)
                .collect());
        }
        tokio::select! {
            _ = tokio::time::sleep(RECHECK.min(remaining)) => {}
            _ = stop.next() => return Err(io::Error::new(io::ErrorKind::Interrupted, "build admission interrupted")),
        }
    }
}
