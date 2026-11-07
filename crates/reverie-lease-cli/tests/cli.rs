//! The actual `reverie-lease` executable over owned synthetic directories.
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-lease-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("work/task")).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn task(&self) -> PathBuf {
        self.0.join("work/task")
    }
    fn lease(&self, arguments: &[&str]) -> Output {
        self.command(arguments).output().unwrap()
    }
    fn command(&self, arguments: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-lease"));
        command
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.0)
            .arg("--leases-dir")
            .arg(self.0.join("leases"))
            .args(arguments);
        command
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn path(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[test]
fn reservations_report_through_check_and_gc() {
    let tree = Tree::new();
    let task = tree.task();
    // `check` scans the given lease dirs and never creates one: missing is UNKNOWN.
    let missing = tree.lease(&["check", path(&task)]);
    assert_eq!(missing.status.code(), Some(2), "{missing:?}");
    assert!(text(&missing).contains(
        "\"state\": \"unknown\", \"why\": \"lease dir missing, symlinked or unreadable: "
    ));
    fs::create_dir(tree.0.join("leases")).unwrap();
    let free = tree.lease(&["check", path(&task)]);
    assert_eq!(free.status.code(), Some(0), "{free:?}");
    assert_eq!(
        text(&free),
        format!(
            "{{\"path\": \"{}\", \"state\": \"free\", \"why\": \"free\"}}\n",
            task.display()
        )
    );
    let reserved = tree.lease(&["reserve", path(&task), "--for", "90m"]);
    assert_eq!(reserved.status.code(), Some(0));
    let key = text(&reserved).trim().to_owned();
    assert!(key.split_once('-').is_some(), "{key}");
    let busy = tree.lease(&["check", path(&task)]);
    assert_eq!(busy.status.code(), Some(1));
    assert!(text(&busy).contains("\"state\": \"in use\", \"why\": \"reserved: "));
    assert_eq!(
        tree.lease(&["renew", path(&task), "--for", "1h"])
            .status
            .code(),
        Some(0)
    );
    assert_eq!(
        tree.lease(&["unreserve", path(&task)]).status.code(),
        Some(0)
    );
    fs::remove_dir(&task).unwrap();
    let collected = tree.lease(&["gc"]);
    assert_eq!(
        text(&collected),
        "{\"removed\": [], \"keptNoPathRecord\": []}\n"
    );
    let refused = tree.lease(&["reserve", path(&tree.0.join("absent")), "--for", "1h"]);
    assert_eq!(refused.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&refused.stderr).starts_with("lease: directory is missing: "));
    let invalid = tree.lease(&["reserve", path(&tree.0), "--for", "1é"]);
    assert_eq!(invalid.status.code(), Some(2));
}

#[test]
fn run_holds_for_the_command_and_returns_its_code() {
    let tree = Tree::new();
    let task = tree.task();
    let check = format!(
        "{} --leases-dir {} check {}",
        env!("CARGO_BIN_EXE_reverie-lease"),
        tree.0.join("leases").display(),
        task.display()
    );
    let output = tree.lease(&[
        "run",
        path(&task),
        "--",
        "sh",
        "-c",
        &format!("{check}; exit 7"),
    ]);
    assert_eq!(output.status.code(), Some(7), "{output:?}");
    assert!(
        text(&output).contains("\"state\": \"in use\", \"why\": \"leased: "),
        "{}",
        text(&output)
    );
    let after = tree.lease(&["check", path(&task)]);
    assert_eq!(after.status.code(), Some(0), "released after the command");
    let usage = tree.lease(&["run", path(&task)]);
    assert_eq!(usage.status.code(), Some(2));
}

#[test]
fn hold_reports_its_key_until_sigterm_and_ls_shows_it() {
    let tree = Tree::new();
    let task = tree.task();
    let mut child = tree
        .command(&["hold", path(&task)])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert!(line.starts_with("LEASED "), "{line}");
    let listed = text(&tree.lease(&["ls"]));
    assert!(
        listed.contains("\"held\": true") && listed.contains("\"argv0\": \"lease-hold\""),
        "{listed}"
    );
    assert_eq!(tree.lease(&["check", path(&task)]).status.code(), Some(1));
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap()),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(0));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(tree.lease(&["check", path(&task)]).status.code(), Some(0));
    assert_eq!(text(&tree.lease(&["ls"])), "[]\n");
}

/// The barrier held exclusively, as a cleanup deleting would hold it.
fn busy_barrier(tree: &Tree) -> nix::fcntl::Flock<fs::File> {
    assert_eq!(
        tree.lease(&["ls"]).status.code(),
        Some(0),
        "creates the lease dir"
    );
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(tree.0.join("leases/barrier.lock"))
        .unwrap();
    nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock).unwrap()
}

fn signal(child: &std::process::Child, signal: nix::sys::signal::Signal) {
    let pid = nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap());
    nix::sys::signal::kill(pid, signal).unwrap();
}

/// Bounded: a stop that is left pending fails here instead of hanging.
fn ended(child: &mut std::process::Child) -> std::process::ExitStatus {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            panic!("a pending stop did not end the command");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn holder_records(tree: &Tree) -> Vec<String> {
    fs::read_dir(tree.0.join("leases"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.ends_with(".json")
                && !name.ends_with(".path.json")
                && !name.ends_with(".reserve.json")
        })
        .collect()
}

#[test]
fn a_stop_at_a_busy_barrier_cancels_without_launching_or_leasing() {
    use std::os::unix::process::ExitStatusExt;
    let tree = Tree::new();
    let task = tree.task();
    let marker = tree.0.join("launched");
    for (wait, stop, release_first) in [
        ("inf", nix::sys::signal::Signal::SIGTERM, false),
        ("nan", nix::sys::signal::Signal::SIGHUP, false),
        // Released right after the stop: acquisition may now win the race,
        // and the pending stop must still prevent the launch.
        ("30", nix::sys::signal::Signal::SIGINT, true),
    ] {
        let barrier = busy_barrier(&tree);
        let mut child = tree
            .command(&[
                "--wait",
                wait,
                "run",
                path(&task),
                "--",
                "touch",
                path(&marker),
            ])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            child.try_wait().unwrap().is_none(),
            "waiting at the barrier"
        );
        signal(&child, stop);
        if release_first {
            drop(barrier);
            let status = ended(&mut child);
            assert_eq!(status.signal(), Some(stop as i32), "{wait}: {status:?}");
        } else {
            let status = ended(&mut child);
            assert_eq!(status.signal(), Some(stop as i32), "{wait}: {status:?}");
            drop(barrier);
        }
        assert!(!marker.exists(), "{wait}: the command never starts");
        assert!(holder_records(&tree).is_empty(), "{wait}: no holder record");
        assert_eq!(tree.lease(&["check", path(&task)]).status.code(), Some(0));
    }
    // `hold` cancels the same way and never announces a lease.
    let barrier = busy_barrier(&tree);
    let mut child = tree
        .command(&["--wait", "inf", "hold", path(&task)])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    signal(&child, nix::sys::signal::Signal::SIGTERM);
    assert_eq!(ended(&mut child).signal(), Some(15));
    drop(barrier);
    let mut announced = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut announced).unwrap();
    assert_eq!(announced, "");
    assert!(holder_records(&tree).is_empty());
}

/// Stdout whose reader is already closed: every write fails with EPIPE.
fn closed_stdout() -> Stdio {
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    Stdio::from(writer)
}

#[test]
fn an_unpublished_result_line_fails_without_undoing_the_operation() {
    let tree = Tree::new();
    let task = tree.task();
    fs::create_dir(tree.0.join("leases")).unwrap();
    let failed = |arguments: &[&str]| {
        let output = tree
            .command(arguments)
            .stdout(closed_stdout())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{arguments:?}: {output:?}");
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(stderr.starts_with("lease: output failed: "), "{stderr}");
    };
    // A read: FREE is not reported as success when its line is lost.
    failed(&["check", path(&task)]);
    // An applied reservation stays applied, exactly once.
    failed(&["reserve", path(&task), "--for", "90m"]);
    let busy = tree.lease(&["check", path(&task)]);
    assert_eq!(busy.status.code(), Some(1), "{busy:?}");
    assert!(text(&busy).contains("\"why\": \"reserved: "));
    let reservations = fs::read_dir(tree.0.join("leases"))
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".reserve.json")
        })
        .count();
    assert_eq!(reservations, 1);
    failed(&["renew", path(&task), "--for", "1h"]);
    assert_eq!(tree.lease(&["check", path(&task)]).status.code(), Some(1));
    assert_eq!(
        tree.lease(&["unreserve", path(&task)]).status.code(),
        Some(0)
    );
    // A lost `LEASED` acknowledgement releases the hold it could not announce.
    failed(&["hold", path(&task)]);
    assert!(holder_records(&tree).is_empty());
    assert_eq!(tree.lease(&["check", path(&task)]).status.code(), Some(0));
    failed(&["gc"]);
    failed(&["ls"]);
}

#[test]
fn ls_shows_a_surrogate_escaped_path_exactly() {
    use std::os::unix::ffi::OsStrExt;
    let tree = Tree::new();
    // Not UTF-8: Python decodes it as the lone surrogate U+DCE9.
    let odd = tree.0.join(std::ffi::OsStr::from_bytes(b"caf\xe9"));
    fs::create_dir(&odd).unwrap();
    // `ls` walks lock files, so the lease must be held, not only reserved.
    let mut holder = tree
        .command(&[])
        .args(["hold".as_ref(), odd.as_os_str()])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(holder.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert!(line.starts_with("LEASED "), "{line}");
    let listed = text(&tree.lease(&["ls"]));
    signal(&holder, nix::sys::signal::Signal::SIGTERM);
    assert_eq!(ended(&mut holder).code(), Some(0));
    // The path field is Python's json.dumps of the str; the holder record
    // carries the same path but goes through the disclosed serde path.
    assert!(listed.contains("\"path\": \""), "{listed}");
    assert!(listed.contains("caf\\udce9\""), "{listed}");
}
