use super::{Tree, program};
use crate::{
    engine_metadata::CancellationToken,
    native::ordered_exec::PreparedExec,
    worker_child::{ChildCause, process::OwnedProcess},
};
use std::{
    ffi::OsString,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
fn start(name: &str, environment: &[(OsString, OsString)]) -> OwnedProcess {
    let program = program();
    let args = [OsString::from(name)];
    let prepared = PreparedExec::new(program, &args, environment).unwrap();
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    OwnedProcess::begin(command, prepared, deadline())
}
#[test]
fn actual_owned_process_exec_error_is_confirmed_before_clean_release() {
    let program = Path::new("/nonexistent-reverie-owned-child");
    let prepared = PreparedExec::new(program, &["fixed".into()], &[]).unwrap();
    let process = OwnedProcess::begin(Command::new(program), prepared, deadline());
    assert!(matches!(
        process
            .wait_ready(deadline(), &CancellationToken::new())
            .unwrap_err()
            .cause(),
        ChildCause::Spawn
    ));
    process.cleanup(deadline()).unwrap();
}
#[test]
fn actual_ordered_exec_status_and_exact_pidfd_cleanup_are_checked() {
    let tree = Tree::new();
    let output = tree.root.join("output");
    let environment = [
        ("Z".into(), "first".into()),
        ("A".into(), "second".into()),
        ("OWNED_OUTPUT".into(), output.into_os_string()),
    ];
    let process = start("exit", &environment);
    process
        .wait_ready(deadline(), &CancellationToken::new())
        .unwrap();
    // The shared immutable controlled executable exits immediately in its
    // default mode; reap/status is via the exact pidfd, never a numeric PID.
    let limit = deadline();
    while process.status().unwrap().is_none() {
        assert!(Instant::now() < limit);
        std::thread::sleep(Duration::from_millis(1));
    }
    process.cleanup(deadline()).unwrap();
    let output = std::fs::read_to_string(tree.root.join("output.relays")).unwrap();
    assert!(output.find("E:5a=6669727374").unwrap() < output.find("E:41=7365636f6e64").unwrap());
}
#[test]
fn cancellation_never_signals_a_separate_owned_sentinel() {
    let sentinel = start("stall", &[]);
    sentinel
        .wait_ready(deadline(), &CancellationToken::new())
        .unwrap();
    let target = start("stall", &[]);
    target
        .wait_ready(deadline(), &CancellationToken::new())
        .unwrap();
    target.cleanup(deadline()).unwrap();
    assert_eq!(target.status().unwrap(), Some(137));
    assert_eq!(sentinel.status().unwrap(), None);
    sentinel.cleanup(deadline()).unwrap();
}
