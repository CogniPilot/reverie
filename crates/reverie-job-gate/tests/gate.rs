//! The real `reverie-job` binary against a fake cgroup root. Pids and start times are real, from
//! `/proc`, so stale and live holders are told apart exactly as on a seat.
use reverie_job_gate::{
    facts::start_time,
    ledger::{Entry, Ledger},
};
use std::{
    fs,
    io::{self, Read},
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const MIB: u64 = 1 << 20;

struct Seat {
    root: PathBuf,
    retained: Arc<AtomicBool>,
}

impl Seat {
    fn new(name: &str, max: &str, stat: &str) -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("job-gate-it-{}-{name}-{nonce}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fs::create_dir_all(root.join("cgroup")).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(root.join("ledger"))
            .unwrap();
        fs::write(root.join("cgroup/memory.max"), max).unwrap();
        fs::write(root.join("cgroup/memory.stat"), stat).unwrap();
        Self {
            root,
            retained: Arc::new(AtomicBool::new(false)),
        }
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

/// The first command is fixed sleep(2) with no admission waiting. Even an
/// assertion/constructor failure must wait for the actual gate/command before
/// deleting its private fixture. Unknown waits are retained, never retried.
struct OwnedFirst {
    child: Option<Child>,
    retained: Arc<AtomicBool>,
}
impl OwnedFirst {
    fn finish(mut self) -> io::Result<ExitStatus> {
        let mut child = self.child.take().expect("actual owned first gate");
        match child.wait() {
            Ok(status) => Ok(status),
            Err(error) => {
                self.retained.store(true, Ordering::SeqCst);
                std::mem::forget(child);
                Err(error)
            }
        }
    }
}
impl Drop for OwnedFirst {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take()
            && child.wait().is_err()
        {
            self.retained.store(true, Ordering::SeqCst);
            std::mem::forget(child);
        }
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        if !self.retained.load(Ordering::SeqCst) {
            let _ = fs::remove_dir_all(&self.root);
        }
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
    let marker = seat.root.join("never-run");
    let out = seat.job(&[
        "run",
        "--estimate",
        "200m",
        "--",
        "touch",
        marker.to_str().unwrap(),
    ]);
    assert_eq!(out.status.code(), Some(75));
    assert!(stderr(&out).contains("exceeds"), "{}", stderr(&out));
    assert!(!marker.exists());
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
    let first = OwnedFirst {
        child: Some(
            Command::new(env!("CARGO_BIN_EXE_reverie-job"))
                .args([
                    "run",
                    "--estimate",
                    "60m",
                    "--wait-secs",
                    "0",
                    "--",
                    "sleep",
                    "2",
                ])
                .env("REVERIE_JOB_CGROUP_ROOT", seat.root.join("cgroup"))
                .env("REVERIE_JOB_PROC_ROOT", "/proc")
                .env("REVERIE_JOB_LEDGER", seat.ledger())
                .spawn()
                .unwrap(),
        ),
        retained: seat.retained.clone(),
    };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while seat.holders().is_empty() && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let first_holders = seat.holders().len();
    let second = seat.job(&["run", "--estimate", "60m", "--wait-secs", "0", "--", "true"]);
    let first_status = first.finish();
    let third = first_status
        .as_ref()
        .ok()
        .filter(|status| status.success())
        .map(|_| seat.job(&["run", "--estimate", "60m", "--wait-secs", "0", "--", "true"]));
    assert_eq!(first_holders, 1, "the first job never reserved");
    assert_eq!(second.status.code(), Some(75), "{}", stderr(&second));
    assert!(first_status.unwrap().success());
    let third = third.expect("first gate and command really completed");
    assert_eq!(third.status.code(), Some(0), "{}", stderr(&third));
}

#[test]
fn a_failed_release_after_the_command_ran_still_reports_the_command_status() {
    let seat = Seat::new("release", &format!("{}\n", 1024 * MIB), &stat(10));
    let ledger = seat.ledger();
    let lock_down = format!("chmod 500 '{}'; exit 3", ledger.display());
    let out = seat.job(&["run", "--estimate", "1m", "--", "sh", "-c", &lock_down]);
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

#[test]
fn a_public_or_symlink_ledger_directory_is_refused_without_chmod() {
    let seat = Seat::new("directory-custody", "100\n", &stat(0));
    fs::set_permissions(seat.ledger(), fs::Permissions::from_mode(0o777)).unwrap();
    let result = Ledger::open(&seat.ledger());
    let accepted = result.is_ok();
    let closed = result.map(Ledger::close);
    assert!(!accepted);
    assert!(closed.is_err());
    assert_eq!(fs::metadata(seat.ledger()).unwrap().mode() & 0o777, 0o777);
    fs::set_permissions(seat.ledger(), fs::Permissions::from_mode(0o700)).unwrap();
    let alias = seat.root.join("alias");
    std::os::unix::fs::symlink(seat.ledger(), &alias).unwrap();
    let result = Ledger::open(&alias);
    let accepted = result.is_ok();
    let _closed = result.map(Ledger::close);
    assert!(!accepted);
    assert!(
        fs::symlink_metadata(alias)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn another_ledger_owner_cannot_supply_the_lock_even_for_the_same_directory() {
    let seat = Seat::new("foreign-lock", "100\n", &stat(0));
    let first = Ledger::open(&seat.ledger()).unwrap();
    let second = Ledger::open(&seat.ledger()).unwrap();
    let held = second.lock().unwrap();
    let add = first.add(&held, me());
    let live = first.live(&held, Path::new("/proc"));
    let remove = first.remove(&held, me().pid);
    let lock_closed = held.close();
    let first_closed = first.close();
    let second_closed = second.close();
    assert!(lock_closed.is_ok() && first_closed.is_ok() && second_closed.is_ok());
    assert!(add.is_err() && live.is_err() && remove.is_err());
    assert!(seat.holders().is_empty());
}

#[test]
fn occupied_regular_hardlink_and_symlink_temps_are_preserved() {
    for kind in ["regular", "hardlink", "symlink"] {
        let seat = Seat::new(kind, "100\n", &stat(0));
        let foreign = seat.root.join("foreign");
        fs::write(&foreign, b"foreign bytes stay").unwrap();
        let temporary = seat.ledger().join(format!("{}.tmp", me().pid));
        match kind {
            "regular" => fs::write(&temporary, b"occupied bytes stay").unwrap(),
            "hardlink" => fs::hard_link(&foreign, &temporary).unwrap(),
            _ => std::os::unix::fs::symlink(&foreign, &temporary).unwrap(),
        }
        let original = fs::read(&temporary).unwrap();
        let inode = fs::symlink_metadata(&temporary).unwrap().ino();
        let ledger = Ledger::open(&seat.ledger()).unwrap();
        let held = ledger.lock().unwrap();
        let result = ledger.add(&held, me());
        let lock_closed = held.close();
        let closed = ledger.close();
        assert!(lock_closed.is_ok() && closed.is_ok());
        assert!(result.is_err());
        assert_eq!(fs::read(&temporary).unwrap(), original);
        assert_eq!(fs::symlink_metadata(&temporary).unwrap().ino(), inode);
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign bytes stay");
        assert!(seat.holders().is_empty());
    }
}

#[test]
fn an_existing_final_entry_is_not_replaced() {
    let seat = Seat::new("occupied-final", "100\n", &stat(0));
    let target = seat.ledger().join(format!("{}.json", me().pid));
    fs::write(&target, b"foreign final bytes").unwrap();
    let inode = fs::metadata(&target).unwrap().ino();
    let ledger = Ledger::open(&seat.ledger()).unwrap();
    let held = ledger.lock().unwrap();
    let result = ledger.add(&held, me());
    let lock_closed = held.close();
    let closed = ledger.close();
    assert!(lock_closed.is_ok() && closed.is_ok());
    assert!(result.is_err());
    assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
    assert_eq!(fs::read(target).unwrap(), b"foreign final bytes");
}

#[test]
fn a_rebound_directory_is_not_used_for_mutations() {
    let seat = Seat::new("directory-rebound", "100\n", &stat(0));
    let ledger = Ledger::open(&seat.ledger()).unwrap();
    let held = ledger.lock().unwrap();
    let original = seat.root.join("original-ledger");
    fs::rename(seat.ledger(), &original).unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(seat.ledger())
        .unwrap();
    let result = ledger.add(&held, me());
    let lock_closed = held.close();
    let closed = ledger.close();
    assert!(lock_closed.is_ok() && closed.is_ok());
    assert!(result.is_err());
    assert_eq!(fs::read_dir(seat.ledger()).unwrap().count(), 0);
    assert_eq!(fs::read_dir(original).unwrap().count(), 1);
}

#[test]
fn an_oversized_record_is_retained_and_refuses() {
    let seat = Seat::new("oversized", &format!("{}\n", 100 * MIB), &stat(0));
    fs::write(seat.ledger().join("4242.json"), vec![b' '; 4097]).unwrap();
    refuses_and_keeps(&seat, Path::new("/proc"), "4242.json");
}

#[test]
fn a_fifo_record_refuses_without_blocking_and_stays_present() {
    let seat = Seat::new("fifo", "100\n", &stat(0));
    let fifo = seat.ledger().join("4242.json");
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
    // Status never dispatches a command: on regression only this owned
    // metadata process needs termination, not an unknown descendant tree.
    let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-job"))
        .arg("status")
        .env("REVERIE_JOB_CGROUP_ROOT", seat.root.join("cgroup"))
        .env("REVERIE_JOB_PROC_ROOT", "/proc")
        .env("REVERIE_JOB_LEDGER", seat.ledger())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Ok(None) => {
                timed_out = true;
                if let Err(error) = child.kill()
                    && !matches!(child.try_wait(), Ok(Some(_)))
                {
                    seat.retained.store(true, Ordering::SeqCst);
                    std::mem::forget(child);
                    panic!("owned metadata termination is unknown: {error}");
                }
                break;
            }
            Err(error) => {
                seat.retained.store(true, Ordering::SeqCst);
                std::mem::forget(child);
                panic!("owned metadata process wait is unknown: {error}");
            }
        }
    }
    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            seat.retained.store(true, Ordering::SeqCst);
            std::mem::forget(child);
            panic!("owned metadata process settlement is unknown: {error}");
        }
    };
    let mut out = child.stdout.take().expect("actual owned stdout pipe");
    let mut err = child.stderr.take().expect("actual owned stderr pipe");
    let mut stdout = Vec::new();
    let mut stderr_bytes = Vec::new();
    let out_read = out.read_to_end(&mut stdout);
    let err_read = err.read_to_end(&mut stderr_bytes);
    let out_closed = nix::unistd::close(out);
    let err_closed = nix::unistd::close(err);
    let output = Output {
        status,
        stdout,
        stderr: stderr_bytes,
    };
    assert!(out_read.is_ok() && err_read.is_ok() && out_closed.is_ok() && err_closed.is_ok());
    assert!(!timed_out, "FIFO record blocked metadata reader");
    assert_eq!(output.status.code(), Some(75), "{}", stderr(&output));
    assert!(fs::symlink_metadata(fifo).is_ok());
}
