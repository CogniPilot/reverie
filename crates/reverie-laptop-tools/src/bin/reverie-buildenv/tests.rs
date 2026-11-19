use super::*;
use std::{
    os::unix::fs::{DirBuilderExt, symlink},
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

struct Fixture {
    root: PathBuf,
    scratch: PathBuf,
    repo: PathBuf,
    limits: admission::Limits,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = env::temp_dir().join(format!(
            "reverie-buildenv-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let repo = root.join("repo");
        let scratch = root.join("scratch");
        let cgroup = root.join("cgroup");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(&cgroup).unwrap();
        let fixture = Self {
            limits: admission::Limits {
                cgroup,
                proc: "/proc".into(),
                disk_reserve: 0,
                memory_headroom: 256 * MIB,
                sample_interval: Duration::from_millis(25),
            },
            root,
            scratch,
            repo,
        };
        fixture.memory(GIB);
        fixture.pids(120, 512);
        fixture
    }

    fn memory(&self, current: u64) {
        let root = &self.limits.cgroup;
        fs::write(root.join("memory.max"), (4 * GIB).to_string()).unwrap();
        fs::write(root.join("memory.current"), current.to_string()).unwrap();
        fs::write(root.join("memory.stat"), "inactive_file 0\n").unwrap();
    }

    fn pids(&self, current: u64, limit: u64) {
        let root = &self.limits.cgroup;
        fs::write(root.join("pids.max"), limit.to_string()).unwrap();
        fs::write(root.join("pids.current"), current.to_string()).unwrap();
    }

    fn cli(&self, extra: &[&str], command: &[&str]) -> Cli {
        let config = [
            "reverie-buildenv",
            "--project",
            "fixture",
            "--repo",
            self.repo.to_str().unwrap(),
            "--scratch",
            self.scratch.to_str().unwrap(),
            "--expect",
            "20M",
            "--disk",
            "1M",
        ];
        Cli::parse_from(
            config
                .into_iter()
                .chain(extra.iter().copied())
                .chain(["--"])
                .chain(command.iter().copied()),
        )
    }

    fn prepare(&self, extra: &[&str], command: &[&str]) -> Build {
        Build::prepare(self.cli(extra, command)).unwrap()
    }

    fn helper(&self) -> PathBuf {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/buildenv_child.rs");
        let target = self.root.join("child");
        let result = Command::new("rustc")
            .args(["--edition", "2024"])
            .arg(source)
            .arg("-o")
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        target
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn cli_and_size_parsing_preserve_gated_command_arguments() {
    let fixture = Fixture::new();
    let build = fixture.prepare(&["--jobs", "3"], &["cargo", "test", "--", "--exact"]);
    assert_eq!(build.cli.command, ["cargo", "test", "--", "--exact"]);
    assert_eq!(build.cli.jobs, 3);
    assert_eq!(admission::size("1.5 GiB").unwrap(), 3 * GIB / 2);
    assert_eq!(admission::size("2T").unwrap(), 2 * (1 << 40));
    assert!(admission::size("2MBjunk").is_err());
    assert!(admission::size("999999999999999999TiB").is_err());
}

#[tokio::test]
async fn refuses_bad_project_pins_memory_tasks_and_disk_without_spawning() {
    let fixture = Fixture::new();
    let mut build = fixture.prepare(&[], &["does-not-exist"]);
    build.cli.project = "..".into();
    let (record, exit) = run(&build, &fixture.limits).await.unwrap();
    assert_eq!(exit, EX_TEMPFAIL);
    assert_eq!(record["problems"], json!(["project must be a plain name"]));
    assert!(!fixture.scratch.join("build").exists());
    build.cli.project = "fixture".into();
    build.cli.disk = u64::MAX;
    fixture.memory(4 * GIB - MIB);
    fixture.pids(1, 65);
    fs::write(
        fixture.repo.join("rust-toolchain.toml"),
        "[toolchain]\nchannel = \"nightly-2099-01-01\"\n",
    )
    .unwrap();
    let (record, exit) = run(&build, &fixture.limits).await.unwrap();
    assert_eq!(exit, EX_TEMPFAIL);
    let problems = record["problems"].as_array().unwrap();
    let prefixes: Vec<_> = problems
        .iter()
        .map(|p| p.as_str().unwrap().split_whitespace().next().unwrap())
        .collect();
    assert_eq!(prefixes, ["pinned", "memory:", "pids-limit:", "disk:"]);
    assert!(!build.ledger.exists());
}

#[tokio::test]
async fn queue_rechecks_transient_pressure_at_a_short_deadline() {
    let fixture = Fixture::new();
    let build = fixture.prepare(&["--wait", "1"], &["true"]);
    fixture.pids(490, 512);
    let cgroup = fixture.limits.cgroup.clone();
    let relieve = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        fs::write(cgroup.join("pids.current"), "120").unwrap();
    });
    let (record, exit) = run(&build, &fixture.limits).await.unwrap();
    relieve.join().unwrap();
    assert_eq!(exit, 0);
    assert_eq!(record["status"], "ok");
    assert!(record["waited_s"].as_f64().unwrap() >= 1.0);
}

#[tokio::test]
async fn holds_the_existing_project_lock_and_refuses_contention() {
    let fixture = Fixture::new();
    let build = fixture.prepare(&[], &["does-not-exist"]);
    let _held = ledger::lock_target(&build.target()).unwrap().unwrap();
    let (record, exit) = run(&build, &fixture.limits).await.unwrap();
    assert_eq!(exit, EX_TEMPFAIL);
    assert_eq!(
        record["problems"],
        json!([format!("another build owns {}", build.target().display())])
    );
    assert!(!build.ledger.exists());
}

#[tokio::test]
async fn refuses_a_redirected_build_target_before_starting_a_child() {
    let fixture = Fixture::new();
    let build = fixture.prepare(&[], &["does-not-exist"]);
    symlink(&fixture.repo, fixture.scratch.join("build")).unwrap();
    let error = run(&build, &fixture.limits).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(
        error
            .to_string()
            .contains("scratch path must be a real directory")
    );
    assert!(!fixture.repo.join("fixture").exists());
    assert!(!build.ledger.exists());
}

#[tokio::test]
async fn runs_in_repo_with_scratch_cache_and_measures_short_lived_peak() {
    let fixture = Fixture::new();
    let helper = fixture.helper();
    let build = fixture.prepare(&["--jobs", "3"], &[helper.to_str().unwrap(), "measure"]);
    let (record, exit) = run(&build, &fixture.limits).await.unwrap();
    assert_eq!((record["status"].as_str(), exit), (Some("ok"), 0));
    let values = fs::read_to_string(fixture.repo.join("ran")).unwrap();
    assert_eq!(
        values.lines().collect::<Vec<_>>(),
        [
            fixture
                .scratch
                .join("build/fixture/cargo")
                .to_str()
                .unwrap(),
            "3",
            "0",
            fixture.scratch.join("tmp").to_str().unwrap(),
            fixture.scratch.join("cache/rust/rustup").to_str().unwrap(),
        ]
    );
    assert!(record["peak_rss_mib"].as_u64().unwrap() >= 80);
    assert!(record["peak_mib"].as_u64().unwrap() >= record["peak_rss_mib"].as_u64().unwrap());
    assert!(
        record["warning"]
            .as_str()
            .unwrap()
            .contains("raise --expect")
    );
    let line = fs::read_to_string(&build.ledger).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), record);
}

#[tokio::test]
async fn watchdog_aborts_the_owned_build_group_and_records_pressure() {
    let fixture = Fixture::new();
    let helper = fixture.helper();
    let build = fixture.prepare(
        &[],
        &[
            helper.to_str().unwrap(),
            "watchdog",
            fixture.limits.cgroup.to_str().unwrap(),
        ],
    );
    let start = Instant::now();
    let (record, exit) = run(&build, &fixture.limits).await.unwrap();
    assert_eq!(exit, EX_TEMPFAIL);
    assert_eq!(record["status"], "aborted_memory");
    assert_eq!(record["exit"], -15);
    assert_eq!(record["watchdog"]["limit"], 4 * GIB);
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn polls_only_the_process_group_and_preserves_unreadable_observations() {
    let fixture = Fixture::new();
    let proc = fixture.root.join("proc");
    for (pid, group, pages) in [(10, 10, 100), (11, 10, 200), (20, 20, 7000)] {
        let dir = proc.join(pid.to_string());
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("stat"),
            format!("{pid} (cc1) (strange) S 1 {group} 0 0"),
        )
        .unwrap();
        fs::write(dir.join("statm"), format!("999 {pages} 0 0 0 0 0")).unwrap();
    }
    assert_eq!(observe::group_rss(&proc, 10, 4096), 300 * 4096);
    fs::remove_file(fixture.limits.cgroup.join("memory.stat")).unwrap();
    fs::remove_file(fixture.limits.cgroup.join("pids.current")).unwrap();
    let samples = observe::Samples::capture(&fixture.limits);
    assert!(samples.peak_cgroup_delta.is_none());
    assert!(samples.peak_pids_delta.is_none());
}

#[test]
fn estimates_select_comparable_successes_preserving_the_ledger_format() {
    let fixture = Fixture::new();
    let ledger = fixture.root.join("ledger");
    for (jobs, status, peak) in [(1, "ok", 500), (2, "ok", 300), (3, "failed", 9000)] {
        ledger::append(&ledger, &json!({"jobs":jobs,"project":"fixture","status":status,"peak_mib":peak,"command":["true"]})).unwrap();
    }
    let command = vec!["true".into()];
    assert_eq!(
        ledger::estimate(&ledger, "fixture", &command, 2),
        Some(375 * MIB)
    );
    assert_eq!(
        ledger::estimate(&ledger, "fixture", &command, 3),
        Some(1875 * MIB)
    );
    assert_eq!(ledger::estimate(&ledger, "other", &command, 2), None);
}

#[test]
fn auto_counts_named_vitest_files_and_ignores_option_values() {
    let fixture = Fixture::new();
    let command = [
        "node",
        "vitest.mjs",
        "run",
        "--config",
        "skip.test.ts",
        "selected.test.ts",
        "two.spec.mjs",
    ]
    .map(str::to_owned);
    assert_eq!(
        vitest::expected("auto", &command, &fixture.repo).unwrap(),
        2
    );
    assert!(vitest::expected("0", &command, &fixture.repo).is_err());
    let summary =
        b"\x1b[2m Test Files \x1b[22m 1 failed | 2 passed (3)\n      Tests  20 passed (20)";
    assert_eq!(vitest::summary(summary), Some(3));
    assert_eq!(vitest::summary(b"no files"), None);
}

#[tokio::test]
async fn checks_the_actual_summary_and_propagates_exit_if_met() {
    let fixture = Fixture::new();
    let helper = fixture.helper();
    let command = helper.to_str().unwrap();
    for (count, wanted, code, label) in [
        ("0", "1", EX_FEWER_FILES, "fewer-files"),
        ("1", "2", EX_FEWER_FILES, "fewer-files"),
        ("2", "2", 3, "failed"),
    ] {
        let build = fixture.prepare(
            &["--expect-files", wanted],
            &[command, "vitest", count, "3"],
        );
        let (record, exit) = run(&build, &fixture.limits).await.unwrap();
        assert_eq!(exit, code);
        assert_eq!(record["status"], label);
        assert_eq!(record["exit"], 3);
        let ran = count.parse::<u64>().unwrap();
        assert_eq!(record["ran_files"], json!((ran > 0).then_some(ran)));
    }
}
