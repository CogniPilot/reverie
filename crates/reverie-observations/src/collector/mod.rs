//! `cleanup/collector.py` effects: the lock, bounded `/proc` and sysfs
//! readings, the prune-run join, the append-only history and `state.json`.
//! Records and rollups are data in `reverie_contracts::collector`.
mod io;
mod probe;

use io::{OutDir, errno_of, os_class, os_message, read_small};
use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg, OFlag, open};
use nix::sys::stat::Mode;
use reverie_contracts::collector::{
    Config, Gpu, Ledger, Out, PruneRead, Roller, State, Window, cpu_pct, cpu_times, day_file, dump,
    join_prune_runs, loadavg, memory, retention_end,
};
use std::collections::BTreeMap;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

/// Why one run did not sample.
#[derive(Debug, Eq, PartialEq)]
pub enum Failure {
    /// `ConfigError`: exit 2.
    Config(String),
    /// Another run holds the lock: exit 5.
    Busy,
    /// An exception Python does not catch: exit 1.
    Fatal(String),
}

fn fatal(errno: Errno, path: &Path) -> Failure {
    Failure::Fatal(format!("{}: {}", os_class(errno), os_message(errno, path)))
}

/// `os.makedirs(out, mode=0o755, exist_ok=True)`: parents with the default
/// mode, the leaf with 0755.
fn make_output(out: &Path) -> Result<(), Failure> {
    if out.is_dir() {
        return Ok(());
    }
    if let Some(parent) = out.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o777)
            .create(parent)
            .map_err(|error| fatal(errno_of(&error), parent))?;
    }
    std::fs::DirBuilder::new()
        .mode(0o755)
        .create(out)
        .map_err(|error| fatal(errno_of(&error), out))
}

fn proc_text(cfg: &Config, name: &str) -> Result<String, &'static str> {
    read_small(&Path::new(&cfg.proc_root).join(name), cfg.max_input_bytes)
        .map_err(|error| error.class())
}

/// The CPU, load, memory, GPU and drive readings into the sample `s`.
/// Returns the new CPU cursor, if one was measured.
fn readings(
    cfg: &Config,
    state: &State,
    sample: &mut Out,
    errors: &mut Vec<(&'static str, Out)>,
) -> Option<(i128, i128)> {
    let measured = proc_text(cfg, "stat")
        .and_then(|text| cpu_times(&text))
        .and_then(|(current, cores)| {
            match state.cpu() {
                Some(previous) => Ok((previous, current, cores)),
                None => {
                    // No usable cursor: measure over one second.
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    #[allow(clippy::cast_precision_loss)]
                    let previous = (current.0 as f64, current.1 as f64);
                    let (current, cores) =
                        proc_text(cfg, "stat").and_then(|text| cpu_times(&text))?;
                    Ok((previous, current, cores))
                }
            }
        });
    let cursor = match measured {
        Ok((previous, current, cores)) => {
            sample.set(
                "cpu_pct",
                cpu_pct(previous, current).map_or(Out::Null, Out::Float),
            );
            let mut cpu = Out::map([("cores", Out::int(cores))]);
            match proc_text(cfg, "loadavg").and_then(|text| loadavg(&text)) {
                Ok(load) => merge(&mut cpu, load),
                Err(class) => errors.push(("loadavg", Out::text(class))),
            }
            sample.set("cpu", cpu);
            Some(current)
        }
        Err(class) => {
            sample.set("cpu_pct", Out::Null);
            sample.set("cpu", Out::Null);
            errors.push(("cpu", Out::text(class)));
            None
        }
    };
    match proc_text(cfg, "meminfo").and_then(|text| memory(&text)) {
        Ok((percent, mem)) => {
            sample.set("mem_pct", Out::Float(percent));
            sample.set("mem", mem);
        }
        Err(class) => {
            sample.set("mem_pct", Out::Null);
            sample.set("mem", Out::Null);
            errors.push(("mem", Out::text(class)));
        }
    }
    let gpu = probe::gpus(cfg).unwrap_or_else(|class| {
        errors.push(("gpu", Out::text(class)));
        Gpu::Error
    });
    let (percent, block) = gpu.out();
    sample.set("gpu_pct", percent);
    sample.set("gpu", block);
    let drives = cfg
        .drives
        .iter()
        .map(|(name, path)| (name.as_str(), probe::drive(path)))
        .collect::<Vec<_>>();
    sample.set("drives", Out::map(drives));
    cursor
}

/// `dict.update` of one map value by another.
fn merge(into: &mut Out, from: Out) {
    if let (Out::Map(map), Out::Map(extra)) = (into, from) {
        map.extend(extra);
    }
}

/// `sorted(os.listdir(log_dir))` as Python `str` code points.
fn summary_names(log_dir: &Path) -> std::io::Result<Vec<Vec<u32>>> {
    let mut names = std::fs::read_dir(log_dir)?
        .map(|entry| {
            entry.map(|entry| reverie_core::posix_text::decode(entry.file_name().as_bytes()))
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    names.sort();
    Ok(names)
}

/// The prune join: the ledger, then summaries not yet committed. Returns the
/// ledger with the joined records appended, and whether it was available.
fn join(
    cfg: &Config,
    out: &Path,
    now: i64,
    sample: &mut Out,
    errors: &mut Vec<(&'static str, Out)>,
) -> Result<(Vec<reverie_contracts::collector::Record>, bool), Failure> {
    let runs_path = out.join("prune-runs.jsonl");
    let ledger = if std::fs::symlink_metadata(&runs_path).is_err() {
        Ledger::Missing
    } else {
        match read_small(&runs_path, cfg.max_file_bytes) {
            Ok(text) => Ledger::from_text(&text),
            Err(_) => Ledger::Unavailable,
        }
    };
    let available = ledger.available();
    let mut joined = Default::default();
    if available {
        let log_dir = PathBuf::from(&cfg.prune_log_dir);
        let names = if cfg.prune_log_dir.is_empty() || !log_dir.is_dir() {
            Ok(None)
        } else {
            summary_names(&log_dir).map(Some)
        };
        match names {
            Ok(names) => {
                let read = |name: &[u32]| {
                    let bytes = reverie_core::posix_text::encode(name).unwrap_or_default();
                    let path = log_dir.join(std::ffi::OsStr::from_bytes(&bytes));
                    match read_small(&path, cfg.max_input_bytes) {
                        Ok(text) => PruneRead::Text(text),
                        Err(error) => PruneRead::Failed(error.message(), error.class()),
                    }
                };
                joined = join_prune_runs(names, read, &ledger, cfg.max_prune_join);
            }
            Err(error) => errors.push(("prune", Out::text(os_class(errno_of(&error))))),
        }
    } else {
        errors.push((
            "prune_runs_file",
            Out::text(
                "ledger_unavailable: prune-runs.jsonl exists but can't be read within bounds",
            ),
        ));
        sample.set("prune_unavailable", Out::Bool(true));
    }
    let mut committed = Vec::new();
    for record in &joined.records {
        let mut record = record.clone();
        record.set("committed_t", Out::int(now));
        let line = dump(&record).ok_or_else(|| Failure::Fatal("ValueError".into()))?;
        io::append_line(&runs_path, &line).map_err(|errno| fatal(errno, &runs_path))?;
        committed.push(record);
    }
    let malformed = ledger.malformed();
    sample.set("prune", Out::List(committed.clone()));
    sample.set("prune_errors", Out::List(joined.errors));
    if joined.backlog > 0 {
        sample.set("prune_backlog", Out::int(joined.backlog));
    }
    if malformed > 0 {
        errors.push((
            "prune_runs_file",
            Out::text(&format!("{malformed} malformed line(s) skipped")),
        ));
    }
    Ok((ledger.into_runs(&committed), available))
}

/// `retention(out, cfg, now)`: remove own history files past their window,
/// in directory order.
fn retention(cfg: &Config, out: &Path, now: i64) -> Result<Vec<Out>, Failure> {
    let mut removed = Vec::new();
    let entries = std::fs::read_dir(out).map_err(|error| fatal(errno_of(&error), out))?;
    for entry in entries {
        let entry = entry.map_err(|error| fatal(errno_of(&error), out))?;
        let path = entry.path();
        let meta =
            std::fs::symlink_metadata(&path).map_err(|error| fatal(errno_of(&error), &path))?;
        if !meta.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let window = match retention_end(&name) {
            Ok(Some((end, rollup))) => {
                let days = if rollup {
                    cfg.rollup_retention_days
                } else {
                    cfg.retention_days
                };
                now - end > days.saturating_mul(86400)
            }
            Ok(None) => false,
            Err(_) => {
                return Err(Failure::Fatal(
                    "ValueError: calendar date out of range".into(),
                ));
            }
        };
        if window {
            std::fs::remove_file(&path).map_err(|error| fatal(errno_of(&error), &path))?;
            removed.push(Out::text(&name));
        }
    }
    Ok(removed)
}

/// `sample_once(cfg, now)`: one sample, its prune join, the closed rollups
/// and retention, under the output directory's exclusive lock.
pub fn sample_once(cfg: &Config, now: Option<i64>) -> Result<Out, Failure> {
    let out = PathBuf::from(&cfg.out_dir);
    if std::fs::symlink_metadata(&out).is_ok_and(|meta| meta.is_symlink()) {
        return Err(Failure::Config(format!(
            "out_dir {} must not be a symlink",
            cfg.out_dir
        )));
    }
    make_output(&out)?;
    let lock_path = out.join(".lock");
    let flags = OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let fd = open(&lock_path, flags, Mode::from_bits_truncate(0o644))
        .map_err(|errno| fatal(errno, &lock_path))?;
    let _lock = match Flock::lock(std::fs::File::from(fd), FlockArg::LockExclusiveNonblock) {
        Ok(lock) => lock,
        Err((_, Errno::EWOULDBLOCK)) => return Err(Failure::Busy),
        Err((_, errno)) => return Err(fatal(errno, &lock_path)),
    };
    let state_path = out.join("state.json");
    let state_text = read_small(&state_path, cfg.max_input_bytes).ok();
    let state = State::from_text(state_text.as_deref());
    let mut sample = Out::map([
        ("v", Out::int(2)),
        ("label", cfg.label.clone()),
        ("interval_s", Out::int(cfg.interval_s)),
    ]);
    let mut errors = Vec::new();
    let cursor = readings(cfg, &state, &mut sample, &mut errors);
    let now = match now {
        Some(now) => now,
        None => std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| {
                i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
            }),
    };
    sample.set("t", Out::int(now));
    let (runs, prune_ok) = join(cfg, &out, now, &mut sample, &mut errors)?;
    if !errors.is_empty() {
        // Later reasons for one component replace earlier ones, as dict keys do.
        let errors = errors.into_iter().collect::<BTreeMap<_, _>>();
        sample.set("errors", Out::map(errors));
    }
    let line = dump(&sample).ok_or_else(|| Failure::Fatal("ValueError".into()))?;
    let day = out.join(day_file(now));
    io::append_line(&day, &line).map_err(|errno| fatal(errno, &day))?;
    let mut files = OutDir {
        dir: out.clone(),
        limit: cfg.max_file_bytes,
        failed: None,
    };
    let mut roller = Roller::new(&mut files);
    // Python's first exception ends the run: the daily roll never starts after
    // a failed hourly one, and nothing below is checkpointed.
    let rolled = roller
        .roll(Window::Hour, &state, now, &runs, prune_ok)
        .and_then(|hour| {
            Ok((
                hour,
                roller.roll(Window::Day, &state, now, &runs, prune_ok)?,
            ))
        });
    if let Some((errno, path)) = files.failed.take() {
        return Err(fatal(errno, &path));
    }
    let (last_hour, last_day) = rolled.map_err(|_| {
        Failure::Fatal("ValueError: Out of range float values are not JSON compliant".into())
    })?;
    let removed = retention(cfg, &out, now)?;
    let mut updates = vec![
        ("last_hour", Out::int(last_hour)),
        ("last_day", Out::int(last_day)),
        ("removed_last", Out::List(removed)),
    ];
    if let Some((total, idle)) = cursor {
        updates.push(("cpu", Out::List(vec![Out::int(total), Out::int(idle)])));
    }
    io::write_state(&state_path, &state.updated(updates))
        .map_err(|errno| fatal(errno, &state_path))?;
    Ok(sample)
}
