//! The real `reverie-job` binary against a fake cgroup root. Pids and start times are real, from
//! `/proc`, so stale and live holders are told apart exactly as on a seat.
use reverie_job_gate::{facts::start_time, ledger::Entry};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const MIB: u64 = 1 << 20;

struct Seat {
    root: PathBuf,
}

impl Seat {
    fn new(name: &str, max: &str, stat: &str) -> Self {
        let root = std::env::temp_dir().join(format!("job-gate-it-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("cgroup")).unwrap();
        fs::create_dir_all(root.join("ledger")).unwrap();
        fs::write(root.join("cgroup/memory.max"), max).unwrap();
        fs::write(root.join("cgroup/memory.stat"), stat).unwrap();
        Self { root }
    }

    fn ledger(&self) -> PathBuf {
        self.root.join("ledger")
    }

    fn hold(&self, entry: Entry) {
        fs::write(
            self.ledger().join(format!("{}.json", entry.pid)),
            serde_json::to_vec(&entry).unwrap(),
        )
        .unwrap();
    }

    fn holders(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.ledger())
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|name| name.ends_with(".json"))
            .collect();
        names.sort();
        names
    }

    fn job(&self, args: &[&str]) -> Output {
        self.job_seeing(Path::new("/proc"), args)
    }

    fn job_seeing(&self, proc: &Path, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_reverie-job"))
            .args(args)
            .env("REVERIE_JOB_CGROUP_ROOT", self.root.join("cgroup"))
            .env("REVERIE_JOB_PROC_ROOT", proc)
            .env("REVERIE_JOB_LEDGER", self.ledger())
            .output()
            .unwrap()
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn stat(anon_mib: u64) -> String {
    format!(
        "anon {}\nfile {}\nkernel 0\nsock 0\n",
        anon_mib * MIB,
        900 * MIB
    )
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn me() -> Entry {
    let pid = std::process::id();
    Entry {
        pid,
        start: start_time(Path::new("/proc"), pid).unwrap(),
        reservation: 0,
    }
}

#[test]
fn runs_the_command_and_releases_its_reservation() {
    let seat = Seat::new("run", &format!("{}\n", 1024 * MIB), &stat(10));
    let out = seat.job(&["run", "--estimate", "1m", "--", "true"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(seat.holders().is_empty());
}

#[test]
fn passes_the_command_exit_status_through() {
    let seat = Seat::new("status", &format!("{}\n", 1024 * MIB), &stat(10));
    let out = seat.job(&["run", "--estimate", "1m", "--", "sh", "-c", "exit 7"]);
    assert_eq!(out.status.code(), Some(7));
    assert!(seat.holders().is_empty());
}

#[test]
fn the_reservation_is_in_the_ledger_while_the_command_runs() {
    let seat = Seat::new("visible", &format!("{}\n", 1024 * MIB), &stat(10));
    let ledger = seat.ledger();
    let out = seat.job(&[
        "run",
        "--estimate",
        "5m",
        "--",
        "ls",
        ledger.to_str().unwrap(),
    ]);
    assert_eq!(out.status.code(), Some(0));
    let listed = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        listed
            .lines()
            .filter(|line| line.ends_with(".json"))
            .count(),
        1,
        "{listed}"
    );
    assert!(seat.holders().is_empty());
}

#[test]
fn an_estimate_above_the_limit_is_refused_without_running() {
    let seat = Seat::new("refuse", &format!("{}\n", 100 * MIB), &stat(1));
    let out = seat.job(&[
        "run",
        "--estimate",
        "200m",
        "--",
        "touch",
        "/nonexistent/never-run",
    ]);
    assert_eq!(out.status.code(), Some(75));
    assert!(stderr(&out).contains("exceeds"), "{}", stderr(&out));
}

#[test]
fn a_live_reservation_holds_its_room_until_released() {
    let seat = Seat::new("held", &format!("{}\n", 100 * MIB), &stat(1));
    seat.hold(Entry {
        reservation: 80 * MIB,
        ..me()
    });
    let out = seat.job(&["run", "--estimate", "20m", "--wait-secs", "0", "--", "true"]);
    assert_eq!(out.status.code(), Some(75));
    assert!(stderr(&out).contains("no room"), "{}", stderr(&out));
    assert_eq!(seat.holders(), vec![format!("{}.json", std::process::id())]);
    fs::remove_file(seat.ledger().join(format!("{}.json", std::process::id()))).unwrap();
    let out = seat.job(&["run", "--estimate", "20m", "--wait-secs", "0", "--", "true"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
}

#[test]
fn a_holder_whose_process_is_gone_or_reused_is_released() {
    let seat = Seat::new("stale", &format!("{}\n", 100 * MIB), &stat(1));
    seat.hold(Entry {
        pid: 4_194_304,
        start: 1,
        reservation: 80 * MIB,
    });
    seat.hold(Entry {
        start: me().start + 1,
        reservation: 80 * MIB,
        ..me()
    });
    let out = seat.job(&["run", "--estimate", "20m", "--wait-secs", "0", "--", "true"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(seat.holders().is_empty());
}

/// Runs a 20 MiB job on a 100 MiB seat (limit 90 MiB) next to a ledger entry the gate cannot
/// classify: it must refuse without running the command and keep the entry.
fn refuses_and_keeps(seat: &Seat, proc: &Path, name: &str) {
    let marker = seat.root.join("ran");
    let out = seat.job_seeing(
        proc,
        &[
            "run",
            "--estimate",
            "20m",
            "--wait-secs",
            "0",
            "--",
            "touch",
            marker.to_str().unwrap(),
        ],
    );
    assert_eq!(out.status.code(), Some(75), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("could not be checked"),
        "{}",
        stderr(&out)
    );
    assert!(stderr(&out).contains(name), "{}", stderr(&out));
    assert!(!marker.exists(), "the command ran");
    assert!(
        seat.holders().contains(&name.to_string()),
        "{:?}",
        seat.holders()
    );
}

#[test]
fn an_unreadable_live_reservation_is_kept_and_refuses() {
    use std::os::unix::fs::PermissionsExt;
    let seat = Seat::new("unreadable-holder", &format!("{}\n", 100 * MIB), &stat(1));
    let entry = Entry {
        reservation: 80 * MIB,
        ..me()
    };
    seat.hold(entry);
    let name = format!("{}.json", entry.pid);
    let file = seat.ledger().join(&name);
    fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(&file).is_ok() {
        // Running with permission checks bypassed: nothing here can be unreadable.
        return;
    }
    refuses_and_keeps(&seat, Path::new("/proc"), &name);
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn a_malformed_reservation_is_kept_and_refuses() {
    let seat = Seat::new("malformed-holder", &format!("{}\n", 100 * MIB), &stat(1));
    fs::write(
        seat.ledger().join("4242.json"),
        b"{\"pid\": 4242, \"start\"",
    )
    .unwrap();
    refuses_and_keeps(&seat, Path::new("/proc"), "4242.json");
}

#[test]
fn a_reservation_filed_under_another_pid_is_kept_and_refuses() {
    let seat = Seat::new("misfiled-holder", &format!("{}\n", 100 * MIB), &stat(1));
    let entry = me();
    fs::write(
        seat.ledger().join("4242.json"),
        serde_json::to_vec(&entry).unwrap(),
    )
    .unwrap();
    refuses_and_keeps(&seat, Path::new("/proc"), "4242.json");
}

#[test]
fn a_dangling_reservation_link_is_kept_and_refuses() {
    let seat = Seat::new("dangling-holder", &format!("{}\n", 100 * MIB), &stat(1));
    std::os::unix::fs::symlink(
        seat.root.join("nowhere.json"),
        seat.ledger().join("4242.json"),
    )
    .unwrap();
    refuses_and_keeps(&seat, Path::new("/proc"), "4242.json");
}

#[test]
fn a_holder_whose_process_state_is_unknown_is_kept_and_refuses() {
    let seat = Seat::new("unknown-stat", &format!("{}\n", 100 * MIB), &stat(1));
    let proc = seat.root.join("proc");
    fs::create_dir_all(proc.join("4242")).unwrap();
    fs::write(proc.join("4242/stat"), "4242 (cargo) S 1").unwrap();
    seat.hold(Entry {
        pid: 4242,
        start: 99,
        reservation: 80 * MIB,
    });
    refuses_and_keeps(&seat, &proc, "4242.json");
}

#[test]
fn unreadable_memory_facts_refuse() {
    let seat = Seat::new(
        "unreadable",
        &format!("{}\n", 1024 * MIB),
        "anon 1\nsock 0\n",
    );
    let out = seat.job(&["run", "--estimate", "1m", "--", "true"]);
    assert_eq!(out.status.code(), Some(75));
    assert!(stderr(&out).contains("unreadable"), "{}", stderr(&out));
}

#[test]
fn status_reports_the_limit_baseline_and_jobs() {
    let seat = Seat::new("report", &format!("{}\n", 1000 * MIB), &stat(100));
    seat.hold(Entry {
        reservation: 50 * MIB,
        ..me()
    });
    let out = seat.job(&["status", "--permille", "500"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["limit"], 500 * MIB);
    assert_eq!(report["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(report["jobs"][0]["reservation"], 50 * MIB);
}

#[test]
fn a_job_admitted_moments_earlier_keeps_a_back_to_back_one_out_until_it_exits() {
    // 90% of 100 MiB is 90 MiB; each job reserves 60 MiB, so only one fits at a time even though
    // neither has used any memory yet.
    let seat = Seat::new("overcommit", &format!("{}\n", 100 * MIB), &stat(1));
    let mut first = Command::new(env!("CARGO_BIN_EXE_reverie-job"))
        .args(["run", "--estimate", "60m", "--", "sleep", "2"])
        .env("REVERIE_JOB_CGROUP_ROOT", seat.root.join("cgroup"))
        .env("REVERIE_JOB_PROC_ROOT", "/proc")
        .env("REVERIE_JOB_LEDGER", seat.ledger())
        .spawn()
        .unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while seat.holders().is_empty() && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(seat.holders().len(), 1, "the first job never reserved");
    let second = seat.job(&["run", "--estimate", "60m", "--wait-secs", "0", "--", "true"]);
    assert_eq!(second.status.code(), Some(75), "{}", stderr(&second));
    assert!(first.wait().unwrap().success());
    let third = seat.job(&["run", "--estimate", "60m", "--wait-secs", "0", "--", "true"]);
    assert_eq!(third.status.code(), Some(0), "{}", stderr(&third));
}

#[test]
fn a_failed_release_after_the_command_ran_still_reports_the_command_status() {
    let seat = Seat::new("release", &format!("{}\n", 1024 * MIB), &stat(10));
    let ledger = seat.ledger();
    let lock_down = format!("chmod 500 '{}'; exit 3", ledger.display());
    let out = seat.job(&["run", "--estimate", "1m", "--", "sh", "-c", &lock_down]);
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&ledger, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    assert!(stderr(&out).contains("not released"), "{}", stderr(&out));
}

#[test]
fn a_command_killed_by_a_signal_exits_128_plus_the_signal() {
    let seat = Seat::new("signal", &format!("{}\n", 1024 * MIB), &stat(10));
    let out = seat.job(&["run", "--estimate", "1m", "--", "sh", "-c", "kill -9 $$"]);
    assert_eq!(out.status.code(), Some(137), "{}", stderr(&out));
    assert!(seat.holders().is_empty());
}
