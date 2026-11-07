//! Each real runtime runs in a separately owned process because signals, cwd,
//! umask and successful same-PID exec deliberately affect the whole process.
use super::*;
use crate::worker_child::tests::{Tree, program};
use std::{
    os::unix::{ffi::OsStringExt, net::UnixListener},
    process::Output,
};
const ENTRY: &str = "worker_child::runtime::tests::entry";
fn run(tree: &Tree, case: &str) -> Output {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", ENTRY, "--nocapture"])
        .env_clear()
        .env("OWNED_ROOT", &tree.root)
        .env("OWNED_CASE", case)
        .env("OWNED_PROGRAM", program())
        .env("OWNED_OUTPUT", tree.root.join("report"))
        .env("PATH", "owner/bin:/opt/reverie/autoenv/bin::owner/bin")
        .env("RAW", OsString::from_vec(vec![255]))
        .env(OsString::from_vec(vec![255]), "rawkey")
        .output()
        .unwrap()
}
#[test]
fn entry() {
    let Some(root) = std::env::var_os("OWNED_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let program = PathBuf::from(std::env::var_os("OWNED_PROGRAM").unwrap());
    let mut runtime = WorkerChildRuntime::installed().unwrap();
    let case = std::env::var("OWNED_CASE").unwrap();
    if case == "signal-fault" {
        restoration_fault(&mut runtime, &root);
        return;
    }
    if case == "signals" {
        native::child_signals::exercise_first_stop_and_errno();
        runtime.finish(Instant::now()).unwrap();
        return;
    }
    runtime.bootstrap = Bootstrap {
        root: root.clone(),
        shim: root.join("shim"),
        model_socket: root.join("model.sock"),
        model: program.clone(),
        office: program.clone(),
        bash: program.clone(),
        pane_program: program,
    };
    let error = if std::env::var("OWNED_CASE").unwrap() == "pane" {
        runtime
            .execute_pane(&root.join("launch.json"), &root.join("launch.exit"))
            .unwrap_err()
    } else {
        runtime
            .execute_record(&root.join("launch.json"))
            .unwrap_err()
    };
    if case == "diagnostic" {
        await_relay(&root);
    }
    let finished = runtime.finish(Instant::now() + Duration::from_secs(2));
    if case == "diagnostic" {
        assert_relay_reaped(&root);
        let _ = reverie_diagnostics::stderr(b"owned child cleanup complete\n");
    }
    fs::write(
        root.join("error"),
        format!(
            "{:?}|{:?}|{:?}|{}",
            error.phase(),
            error.record_disposition(),
            error.cleanup_faults(),
            finished.is_ok()
        ),
    )
    .unwrap();
    finished.unwrap();
}
fn await_relay(root: &Path) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !fs::read_to_string(root.join("report.relays"))
        .is_ok_and(|data| data.starts_with("PID:") && data.contains('\n'))
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn assert_relay_reaped(root: &Path) {
    let report = fs::read_to_string(root.join("report.relays")).unwrap();
    for line in report.lines().filter_map(|line| line.strip_prefix("PID:")) {
        assert!(!Path::new("/proc").join(line).exists());
    }
}
#[test]
fn full_stderr_socket_does_not_delay_actual_owned_relay_settlement() {
    use std::{
        io::Write,
        os::{fd::OwnedFd, unix::net::UnixStream},
    };
    let tree = Tree::new();
    let _ = program();
    tree.record(&serde_json::to_vec(&serde_json::json!({"env":{"OWNED_STALL":"1"},"cwd":tree.root.join("missing"),"command":"x"})).unwrap());
    let (_reader, mut writer) = UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    while writer.write(&[b'x'; 4096]).is_ok() {}
    writer.set_nonblocking(false).unwrap();
    let fd: OwnedFd = writer.into();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", ENTRY, "--nocapture"])
        .env_clear()
        .env("OWNED_ROOT", &tree.root)
        .env("OWNED_CASE", "diagnostic")
        .env("OWNED_PROGRAM", program())
        .env("OWNED_OUTPUT", tree.root.join("report"))
        .stderr(Stdio::from(fd))
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let result = child.try_wait().unwrap();
    if result.is_none() {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert!(result.is_some_and(|status| status.success()));
    assert!(
        fs::read_to_string(tree.root.join("error"))
            .unwrap()
            .ends_with("|true")
    );
}
fn restoration_fault(runtime: &mut WorkerChildRuntime, root: &Path) {
    native::child_signals::fail_restore_once();
    let first = runtime.finish(Instant::now()).unwrap_err();
    let second = runtime.finish(Instant::now()).unwrap_err();
    assert!(first.cleanup_faults().contains(&ChildCleanup::Signal));
    assert!(second.cleanup_faults().contains(&ChildCleanup::Signal));
    assert!(WorkerChildRuntime::installed().is_err());
    fs::write(root.join("fenced"), b"retained").unwrap();
}
#[test]
fn first_stop_and_failed_signal_restoration_never_refresh_or_clear_the_fence() {
    let tree = Tree::new();
    assert!(run(&tree, "signals").status.success());
    assert!(run(&tree, "signal-fault").status.success());
    assert_eq!(fs::read(tree.root.join("fenced")).unwrap(), b"retained");
}
#[test]
fn actual_pane_child_keeps_stdio_publishes_once_and_retains_the_pane() {
    use std::io::{Read, Write};
    let tree = Tree::new();
    tree.record(b"37");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", ENTRY, "--nocapture"])
        .env_clear()
        .env("OWNED_ROOT", &tree.root)
        .env("OWNED_CASE", "pane")
        .env("OWNED_PROGRAM", program())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"owned-marker\n")
        .unwrap();
    let limit = Instant::now() + Duration::from_secs(5);
    while !tree.root.join("launch.exit").exists() && Instant::now() < limit {
        std::thread::sleep(Duration::from_millis(5));
    }
    let receipt = fs::read(tree.root.join("launch.exit"));
    let alive = child.try_wait().unwrap().is_none();
    child.kill().unwrap();
    child.wait().unwrap();
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert_eq!(receipt.unwrap(), b"37");
    assert!(alive);
    assert!(output.contains("PANE:owned-marker"));
    assert!(!tree.root.join("launch.exit.tmp").exists());
}
#[test]
fn real_record_relays_then_same_pid_exec_preserves_raw_env_and_exact_argv() {
    let tree = Tree::new();
    let _ = program();
    fs::create_dir(tree.root.join("shim")).unwrap();
    let _model = UnixListener::bind(tree.root.join("model.sock")).unwrap();
    let record = serde_json::json!({"env":{"NOT_ALLOWLISTED":"retained","REVERIE_WORKER_SOCKET":"private","CARGO_TARGET_DIR":"explicit"},"cwd":tree.root,"command":"37"});
    tree.record(&serde_json::to_vec(&record).unwrap());
    let output = run(&tree, "exec");
    assert_eq!(
        output.status.code(),
        Some(37),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!tree.root.join("launch.json").exists());
    let report = fs::read_to_string(tree.root.join("report")).unwrap();
    assert!(report.contains("A:62617368\nA:2d63\nA:3337\n"));
    assert!(report.contains("E:524157=ff\n"));
    assert!(report.contains("E:ff=7261776b6579\n"));
    assert!(report.contains("E:4e4f545f414c4c4f574c4953544544=72657461696e6564\n"));
    assert!(!report.contains("524556455249455f574f524b45525f534f434b4554="));
    let relays = fs::read_to_string(tree.root.join("report.relays")).unwrap();
    assert!(relays.contains("A:2f62696e2f726576657269652d6d6f64656c2d72656c6179\n"));
    assert!(relays.contains("A:2f62696e2f726576657269652d6f66666963652d72656c6179\n"));
}
#[test]
fn real_unlink_precedes_invalid_environment_and_failed_chdir_settles_relays() {
    let tree = Tree::new();
    tree.record(br#"{"env":{"INVALID":null},"cwd":"/unused","command":"x"}"#);
    assert!(run(&tree, "invalid-env").status.success());
    assert!(!tree.root.join("launch.json").exists());
    assert!(
        fs::read_to_string(tree.root.join("error"))
            .unwrap()
            .starts_with("Relay|Consumed|")
    );
    let path = serde_json::json!({"env":{},"cwd":tree.root.join("absent"),"command":"x"});
    tree.record(&serde_json::to_vec(&path).unwrap());
    assert!(run(&tree, "chdir").status.success());
    assert!(!tree.root.join("launch.json").exists());
    assert!(
        fs::read_to_string(tree.root.join("error"))
            .unwrap()
            .starts_with("Directory|Consumed|")
    );
}
