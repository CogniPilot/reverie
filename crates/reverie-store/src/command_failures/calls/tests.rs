use super::*;
use crate::command_failures::tests::Tree;
#[test]
fn real_refused_sqlite_close_is_retained_before_admission_release_and_fences_siblings() {
    const NAME: &str = "command_failures::calls::tests::real_refused_sqlite_close_is_retained_before_admission_release_and_fences_siblings";
    const ENV: &str = "REVERIE_TELEMETRY_SQLITE_CLOSE_CASE";
    if std::env::var(ENV).as_deref() != Ok(NAME) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--test-threads=1"])
            .env(ENV, NAME)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        return;
    }
    // This isolated process deliberately retains a test-only native SQLite
    // statement to force SQLITE_BUSY from sqlite3_close. No product unsafe,
    // callback or raw Connection API is introduced; process exit releases
    // the deliberately unfinalized test statement after the owned proof.
    let tree = Tree::new();
    let owner = std::sync::Arc::new(LearningLogs::new());
    let directory = tree.0.join("hands");
    let employee = tree.employee();
    let uid = tree.uid();
    let (ready_rx, go_tx, done_rx, release_tx, task) =
        start_refused_call(&owner, directory.clone(), employee.clone(), uid);
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(15))
        .unwrap();
    let paused = owner
        .open(&directory, &employee, &[TelemetryKey::Shell], uid)
        .unwrap();
    assert!(
        owner
            .open(&directory, &employee, &[TelemetryKey::Shell], uid)
            .is_err()
    );
    go_tx.send(()).unwrap();
    done_rx
        .recv_timeout(std::time::Duration::from_secs(15))
        .unwrap();
    let inspect = rusqlite::Connection::open(tree.0.join("hands/command-failures.sqlite")).unwrap();
    let count: i64 = inspect
        .query_row("SELECT count(*) FROM failures", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1, "close refusal does not imply rollback");
    inspect.close().unwrap();
    assert!(owner.has_unconfirmed());
    assert!(owner.has_pending());
    assert!(
        owner
            .state
            .lock()
            .unwrap()
            .retained
            .iter()
            .any(|error| matches!(error, FailureStoreError::Close(_)))
    );
    assert!(
        paused.report(1_000_000).is_err(),
        "an already admitted sibling cannot reopen after close uncertainty"
    );
    let never = tree.0.join("never-opened");
    assert!(
        owner
            .open(&never, &employee, &[TelemetryKey::Shell], uid)
            .is_err()
    );
    assert!(!never.exists());
    drop(paused);
    assert_eq!(
        owner.state.lock().unwrap().active,
        1,
        "actual first caller remains paused before return"
    );
    release_tx.send(()).unwrap();
    task.join().unwrap();
    assert_eq!(owner.state.lock().unwrap().active, 0);
    assert!(owner.has_pending());
}

type RefusedCall = (
    std::sync::mpsc::Receiver<()>,
    std::sync::mpsc::Sender<()>,
    std::sync::mpsc::Receiver<()>,
    std::sync::mpsc::Sender<()>,
    std::thread::JoinHandle<()>,
);
fn start_refused_call(
    owner: &std::sync::Arc<LearningLogs>,
    directory: std::path::PathBuf,
    employee: ProfileEmployeeId,
    uid: u32,
) -> RefusedCall {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (go_tx, go_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let owner = owner.clone();
    let task = std::thread::spawn(move || {
        let first = owner
            .open(&directory, &employee, &[TelemetryKey::Shell], uid)
            .unwrap();
        ready_tx.send(()).unwrap();
        go_rx
            .recv_timeout(std::time::Duration::from_secs(15))
            .unwrap();
        crate::command_failures::tests::FORGET_STATEMENT.with(|flag| flag.set(true));
        assert!(
            first
                .observe(&crate::command_failures::tests::event(0, 127), 1_000_000)
                .is_err()
        );
        done_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(15))
            .unwrap();
        drop(first);
    });
    (ready_rx, go_tx, done_rx, release_tx, task)
}
