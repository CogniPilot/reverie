//! Exercise the packaged workspaces command and its shared lease registry.
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use reverie_host::lease::{self, LeaseBase};
use serde_json::{Value, json};
use std::{
    fs::{self, DirBuilder},
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-workspaces-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-workspaces"));
        command
            .env("REVERIE_LEASE_DIR", self.0.join("leases"))
            .env("REVERIE_TASKS_ROOT", self.0.join("tasks"))
            .args(args);
        command
    }

    fn call(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn ok(&self, args: &[&str]) -> Output {
        let output = self.call(args);
        assert!(output.status.success(), "{args:?}: {output:?}");
        output
    }

    fn task(&self) -> PathBuf {
        self.0.join("tasks/check")
    }

    fn record(&self) -> Value {
        serde_json::from_slice(&fs::read(self.task().join(".reverie-task.json")).unwrap()).unwrap()
    }

    fn run(&self, instruction: &str) -> Command {
        let mut command = self.command(&["run", "check", "--"]);
        command
            .env("REVERIE_TEST_WORKSPACE_CHILD", instruction)
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", "command_fixture"]);
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn json_output(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn command_fixture() {
    let Ok(instruction) = std::env::var("REVERIE_TEST_WORKSPACE_CHILD") else {
        return;
    };
    let current = std::env::current_dir().unwrap();
    let record: Value =
        serde_json::from_slice(&fs::read(current.join(".reverie-task.json")).unwrap()).unwrap();
    assert_eq!(record["status"], "running");
    for variable in ["TMPDIR", "TMP", "TEMP"] {
        assert_eq!(
            PathBuf::from(std::env::var_os(variable).unwrap()),
            current.join("tmp")
        );
    }
    assert_eq!(
        PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").unwrap()),
        current.join("build")
    );
    if instruction == "stop" {
        fs::write("ready", "").unwrap();
        std::thread::sleep(Duration::from_secs(15));
    }
    if instruction == "failure" {
        std::process::exit(7);
    }
}

#[test]
fn native_cli_runs_and_cleans_existing_format_workspaces() {
    let f = Fixture::new();
    let created = f.ok(&["create", "check"]);
    assert_eq!(
        String::from_utf8(created.stdout).unwrap().trim_end(),
        f.task().to_str().unwrap()
    );
    let renewed = f.ok(&["renew-all"]);
    assert_eq!(json_output(&renewed)["check"], "renewed");
    assert!(!f.call(&["clean", "check", "--apply"]).status.success());
    assert_eq!(f.run("failure").status().unwrap().code(), Some(7));
    assert_eq!(f.record()["status"], "failed");
    assert_eq!(f.record()["exit_code"], 7);
    assert!(f.run("success").status().unwrap().success());
    assert_eq!(f.record()["status"], "awaiting_handoff");
    f.ok(&["finish", "check", "--handoff", "saved report"]);
    assert_eq!(f.record()["handoff"], "saved report");
    let dry_run = f.ok(&["clean", "check"]);
    assert_eq!(
        json_output(&dry_run),
        json!({"workspace": "check", "removed": false})
    );
    let base = LeaseBase::own(&f.0.join("leases")).unwrap();
    let held = lease::hold(
        &base,
        &[f.task()],
        "test-holder".as_ref(),
        Duration::from_secs(1),
    )
    .unwrap();
    assert!(!f.call(&["clean", "check", "--apply"]).status.success());
    drop(held);
    fs::write(f.task().join(".git"), "gitdir: somewhere").unwrap();
    assert!(!f.call(&["clean", "check", "--apply"]).status.success());
    fs::remove_file(f.task().join(".git")).unwrap();
    let clean = f.ok(&["clean", "check", "--apply"]);
    assert_eq!(
        json_output(&clean),
        json!({"workspace": "check", "removed": true})
    );
    assert!(!f.task().exists());
}

#[test]
fn stopping_the_cli_settles_the_command_before_handoff() {
    let f = Fixture::new();
    f.ok(&["create", "check"]);
    let mut run = f.run("stop").spawn().unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while !f.task().join("ready").exists() {
        assert!(run.try_wait().unwrap().is_none(), "run exited before ready");
        assert!(Instant::now() < until, "run did not become ready");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !f.call(&["finish", "check", "--handoff", "too early"])
            .status
            .success()
    );
    kill(
        Pid::from_raw(i32::try_from(run.id()).unwrap()),
        Signal::SIGTERM,
    )
    .unwrap();
    assert_eq!(run.wait().unwrap().code(), Some(241));
    let record = f.record();
    assert_eq!(record["status"], "failed");
    assert_eq!(record["exit_code"], -15);
    f.ok(&["finish", "check", "--handoff", "stopped"]);
}
