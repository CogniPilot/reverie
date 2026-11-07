//! The native collector against the Python `collector.sample_once` oracle:
//! one eight-step scenario on fixture `/proc` and sysfs roots, recorded once
//! from the Python collector (fixtures/collector-oracle.txt). Every output
//! file must match byte for byte after every step.
use reverie_contracts::collector::{Config, Out};
use reverie_observations::collector::sample_once;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const T0: i64 = 1_792_940_400;
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Env {
    root: PathBuf,
}

fn put(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

impl Env {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "collect-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("out")).unwrap();
        let env = Self { root };
        env.cpu(1000, 900);
        env.mem(8_388_608, 6_291_456);
        put(&env.path("proc/loadavg"), "0.50 0.40 0.30 1/100 42\n");
        put(
            &env.path("sys/class/drm/card0/device/gpu_busy_percent"),
            "37\n",
        );
        put(
            &env.path("sys/class/drm/card1/device/gpu_busy_percent"),
            "bad\n",
        );
        fs::create_dir_all(env.path("sys/class/drm/renderD128")).unwrap();
        env
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }
    fn cpu(&self, total: i64, idle: i64) {
        put(
            &self.path("proc/stat"),
            &format!(
                "cpu  {} 0 0 {idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0 0 0\n",
                total - idle
            ),
        );
    }
    fn mem(&self, total: i64, available: i64) {
        put(
            &self.path("proc/meminfo"),
            &format!("MemTotal: {total} kB\nMemFree: 1 kB\nMemAvailable: {available} kB\n"),
        );
    }
    fn cfg(&self) -> Config {
        let text = |relative: &str| self.path(relative).to_str().unwrap().to_owned();
        Config {
            out_dir: text("out"),
            label: Out::text("oracle"),
            proc_root: text("proc"),
            sys_root: text("sys"),
            prune_log_dir: text("logs"),
            drives: BTreeMap::from([("missing".to_owned(), text("nope"))]),
            nvidia_smi: "no-such-nvidia-smi".into(),
            max_prune_join: 2,
            ..Config::default()
        }
    }
    /// One sample at `now`, then every output file except the lock.
    fn step(&self, now: i64, capture: &mut String) {
        sample_once(&self.cfg(), Some(now)).unwrap();
        capture.push_str(&format!("### step {now}\n"));
        let mut names = fs::read_dir(self.path("out"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name != ".lock")
            .collect::<Vec<_>>();
        names.sort();
        for name in names {
            let text = fs::read_to_string(self.path("out").join(&name)).unwrap();
            capture.push_str(&format!("== {name}\n{text}\n"));
        }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn eight_steps_match_the_python_collector_byte_for_byte() {
    let env = Env::new();
    for (name, text) in [
        (
            "a",
            r#"{"mode": "dry", "exit": 0, "deleted_or_would_bytes": 1000, "by_decision": {"stale": 2}, "passes": ["tmp"]}"#,
        ),
        (
            "b",
            r#"{"mode": "live", "exit": 4, "deleted_or_would_bytes": 500.5}"#,
        ),
        (
            "c",
            r#"{"mode": "live", "exit": 0, "deleted_or_would_bytes": 2048.0, "ceiling_hit": true}"#,
        ),
        ("d", r#"{"mode": "maybe", "exit": 0}"#),
        ("e", "[1]"),
        (
            "f",
            r#"{"run_id": "custom-id", "mode": "live", "exit": 7, "deleted_or_would_bytes": 0}"#,
        ),
    ] {
        put(&env.path(&format!("logs/{name}.summary.json")), text);
    }
    put(&env.path("logs/notes.txt"), "ignored");
    let out = |name: &str| env.path("out").join(name);
    let mut capture = String::new();
    env.step(T0 + 10, &mut capture);
    env.cpu(1600, 1200);
    env.mem(8_388_608, 4_194_304);
    env.step(T0 + 310, &mut capture);
    env.step(T0 + 3610, &mut capture);
    let mut day = fs::read_to_string(out("samples-2026-10-25.jsonl")).unwrap();
    day.push_str("{\"t\": 1");
    fs::write(out("samples-2026-10-25.jsonl"), day).unwrap();
    env.step(T0 + 3910, &mut capture);
    fs::remove_file(out("state.json")).unwrap();
    env.step(T0 + 7300, &mut capture);
    put(&out("samples-2026-09-01.jsonl"), "{\"t\": 1}\n");
    put(&out("rollup-hour-2025-01.jsonl"), "{}\n");
    put(&out("rollup-day-2024.jsonl"), "{}\n");
    put(&out("other.jsonl"), "{}\n");
    env.step(T0 + 86400 + 100, &mut capture);
    fs::rename(out("prune-runs.jsonl"), out("prune-runs.real")).unwrap();
    std::os::unix::fs::symlink("prune-runs.real", out("prune-runs.jsonl")).unwrap();
    put(
        &env.path("logs/g.summary.json"),
        r#"{"mode": "dry", "exit": 0, "deleted_or_would_bytes": 7}"#,
    );
    env.step(T0 + 86400 + 400, &mut capture);
    fs::remove_file(out("prune-runs.jsonl")).unwrap();
    fs::rename(out("prune-runs.real"), out("prune-runs.jsonl")).unwrap();
    env.step(T0 + 86400 + 3700, &mut capture);
    let expected = include_str!("fixtures/collector-oracle.txt");
    for (index, (got, want)) in capture.lines().zip(expected.lines()).enumerate() {
        assert_eq!(got, want, "line {}", index + 1);
    }
    assert_eq!(capture, expected);
}

use reverie_contracts::collector::dump;
use reverie_observations::collector::Failure;
use std::os::unix::fs::PermissionsExt;

impl Env {
    fn summary(&self, id: &str, mode: &str, exit: i64, bytes: i64) {
        put(
            &self.path(&format!("logs/{id}.summary.json")),
            &format!(r#"{{"mode": "{mode}", "exit": {exit}, "deleted_or_would_bytes": {bytes}}}"#),
        );
    }
    /// A usable CPU cursor, so a sample does not wait one second.
    fn seed_state(&self) {
        put(&self.path("out/state.json"), r#"{"cpu":[0,0]}"#);
    }
    fn lines(&self, name: &str) -> Vec<serde_json::Value> {
        fs::read_to_string(self.path("out").join(name))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn hour_starts(&self) -> Vec<i64> {
        let mut names = fs::read_dir(self.path("out"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.starts_with("rollup-hour"))
            .collect::<Vec<_>>();
        names.sort();
        names
            .iter()
            .flat_map(|name| self.lines(name))
            .map(|record| record["start"].as_i64().unwrap())
            .collect()
    }
    fn sample(&self, cfg: &Config, now: i64) -> serde_json::Value {
        let sample = sample_once(cfg, Some(now)).unwrap();
        serde_json::from_str(&dump(&sample).unwrap()).unwrap()
    }
}

#[test]
fn lock_busy_and_symlinked_out_dir() {
    let env = Env::new();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(env.path("out/.lock"))
        .unwrap();
    let held = nix::fcntl::Flock::lock(lock, nix::fcntl::FlockArg::LockExclusive).unwrap();
    assert_eq!(sample_once(&env.cfg(), Some(T0)), Err(Failure::Busy));
    drop(held);
    let link = env.path("linked-out");
    std::os::unix::fs::symlink(env.path("out"), &link).unwrap();
    let cfg = Config {
        out_dir: link.to_str().unwrap().into(),
        ..env.cfg()
    };
    assert!(
        matches!(sample_once(&cfg, Some(T0)), Err(Failure::Config(message)) if message.ends_with("must not be a symlink"))
    );
}

#[test]
fn checkpoint_failure_does_not_duplicate_prune_runs_or_rollups() {
    let env = Env::new();
    env.seed_state();
    env.summary("r1", "dry", 0, 10);
    env.sample(&env.cfg(), T0 + 10);
    // The state checkpoint fails: the sample and its join are durable.
    fs::create_dir(env.path("out/state.json.tmp")).unwrap();
    assert!(matches!(
        sample_once(&env.cfg(), Some(T0 + 3610)),
        Err(Failure::Fatal(_))
    ));
    fs::remove_dir(env.path("out/state.json.tmp")).unwrap();
    env.sample(&env.cfg(), T0 + 3910);
    let ids = env
        .lines("prune-runs.jsonl")
        .iter()
        .map(|run| run["run_id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(ids, [serde_json::json!("r1")]);
    assert_eq!(env.hour_starts(), [T0]);
}

#[test]
fn first_checkpoint_failure_before_any_rollup_keeps_first_hour() {
    let env = Env::new();
    env.seed_state();
    fs::create_dir(env.path("out/state.json.tmp")).unwrap();
    assert!(matches!(
        sample_once(&env.cfg(), Some(T0 + 10)),
        Err(Failure::Fatal(_))
    ));
    fs::remove_dir(env.path("out/state.json.tmp")).unwrap();
    env.sample(&env.cfg(), T0 + 3601);
    env.sample(&env.cfg(), T0 + 7201);
    assert_eq!(env.hour_starts(), [T0, T0 + 3600]);
}

#[test]
fn oversize_or_unreadable_ledger_skips_prune_accounting() {
    let env = Env::new();
    env.seed_state();
    env.summary("live1", "live", 0, 700);
    let first = env.sample(&env.cfg(), T0);
    assert_eq!(first["prune"][0]["run_id"], "live1");
    let ledger = env.path("out/prune-runs.jsonl");
    let size = i64::try_from(fs::metadata(&ledger).unwrap().len()).unwrap();
    let bounded = Config {
        max_file_bytes: (size - 1).max(1),
        ..env.cfg()
    };
    let second = env.sample(&bounded, T0 + 300);
    assert_eq!(second["prune"], serde_json::json!([]));
    assert_eq!(second["prune_unavailable"], true);
    assert!(
        second["errors"]["prune_runs_file"]
            .as_str()
            .unwrap()
            .contains("ledger_unavailable")
    );
    assert!(second["mem_pct"].is_number());
    fs::set_permissions(&ledger, fs::Permissions::from_mode(0o000)).unwrap();
    let third = env.sample(&env.cfg(), T0 + 600);
    fs::set_permissions(&ledger, fs::Permissions::from_mode(0o644)).unwrap();
    if !nix::unistd::geteuid().is_root() {
        assert_eq!(third["prune_unavailable"], true);
    }
    let fourth = env.sample(&env.cfg(), T0 + 900);
    assert_eq!(fourth["prune"], serde_json::json!([]));
    assert_eq!(env.lines("prune-runs.jsonl").len(), 1);
}

#[test]
fn rollup_during_unavailable_ledger_is_null_not_zero() {
    let env = Env::new();
    env.seed_state();
    env.summary("live1", "live", 0, 700);
    for step in 0..12 {
        env.sample(&env.cfg(), T0 + step * 300);
    }
    // Close hour T0 while only the ledger is unreadable.
    let ledger = env.path("out/prune-runs.jsonl");
    fs::set_permissions(&ledger, fs::Permissions::from_mode(0o000)).unwrap();
    env.sample(&env.cfg(), T0 + 3600 + 10);
    fs::set_permissions(&ledger, fs::Permissions::from_mode(0o644)).unwrap();
    if nix::unistd::geteuid().is_root() {
        return;
    }
    let hour = env
        .lines("rollup-hour-2026-10.jsonl")
        .into_iter()
        .find(|record| record["start"] == T0)
        .unwrap();
    assert_eq!(hour["prune_unavailable"], true);
    assert!(hour["prune_bytes"].is_null());
}

#[test]
fn new_missing_ledger_still_joins_and_bad_readings_are_errors() {
    let env = Env::new();
    env.seed_state();
    env.summary("d1", "dry", 0, 1);
    put(&env.path("proc/meminfo"), "garbage\n");
    put(&env.path("proc/stat"), "nope\n");
    let sample = env.sample(&env.cfg(), T0);
    assert_eq!(sample["prune"][0]["run_id"], "d1");
    assert!(sample.get("prune_unavailable").is_none());
    assert!(sample["mem_pct"].is_null() && sample["cpu_pct"].is_null());
    assert_eq!(sample["errors"]["mem"], "InputError");
    assert_eq!(sample["errors"]["cpu"], "InputError");
}

#[test]
fn an_unencodable_rollup_fails_the_sample_and_keeps_the_cursor() {
    // Python reference for this history: ValueError ("Out of range float
    // values are not JSON compliant: inf"), state.json unchanged, no rollup
    // file, and the new sample line appended.
    let env = Env::new();
    let state = format!(r#"{{"cpu":[1000,900],"last_day":1792886400,"last_hour":{T0}}}"#);
    put(&env.path("out/state.json"), &state);
    put(
        &env.path("out/samples-2026-10-25.jsonl"),
        &format!(
            "{{\"t\": {}, \"cpu_pct\": 1e308}}\n{{\"t\": {}, \"cpu_pct\": 1e308}}\n",
            T0 + 10,
            T0 + 20
        ),
    );
    let cfg = Config {
        gpu_auto: false,
        prune_log_dir: String::new(),
        drives: BTreeMap::new(),
        ..env.cfg()
    };
    assert!(
        matches!(sample_once(&cfg, Some(T0 + 3610)), Err(Failure::Fatal(message)) if message.starts_with("ValueError"))
    );
    assert_eq!(
        fs::read_to_string(env.path("out/state.json")).unwrap(),
        state
    );
    assert!(!env.path("out/rollup-hour-2026-10.jsonl").exists());
    assert!(!env.path("out/rollup-day-2026.jsonl").exists());
    assert_eq!(env.lines("samples-2026-10-25.jsonl").len(), 3);
}
