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
