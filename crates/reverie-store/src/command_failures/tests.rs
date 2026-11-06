use super::*;
use reverie_core::command_telemetry::{FailureExit, FailureTool};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::atomic::{AtomicUsize, Ordering},
};
const E: &str = "11111111-1111-1111-1111-111111111111";
static NEXT: AtomicUsize = AtomicUsize::new(0);
pub(super) struct Tree(pub(super) PathBuf);
impl Tree {
    pub(super) fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "failure-db-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    pub(super) fn employee(&self) -> ProfileEmployeeId {
        ProfileEmployeeId::parse(E).unwrap()
    }
    fn log(&self) -> Result<FailureLog> {
        FailureLog::open(
            &self.0.join("hands"),
            &self.employee(),
            &[TelemetryKey::Shell],
            fs::metadata(&self.0).unwrap().uid(),
            super::OpenPurpose::CreateHands,
        )
    }
    pub(super) fn uid(&self) -> u32 {
        fs::metadata(&self.0).unwrap().uid()
    }
    fn path(&self) -> PathBuf {
        self.0.join("hands/command-failures.sqlite")
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
pub(super) fn event(identity: u128, exit: i16) -> FailureEvent {
    FailureEvent::new(
        reverie_core::ids::ProfileSessionId::parse(&format!(
            "00000000-0000-0000-0000-{identity:012x}"
        ))
        .unwrap(),
        FailureTool::Known(TelemetryKey::Shell),
        FailureExit::try_new(exit).unwrap(),
    )
}
#[test]
fn actual_python_sqlite_malformed_rows_counters_expiry_and_reopen_cases() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/command-telemetry/sqlite-legacy.json"
    ))
    .unwrap();
    let extra: Value = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/command-telemetry/sqlite-counters-legacy.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in cases
        .as_array()
        .unwrap()
        .iter()
        .chain(extra.as_array().unwrap())
    {
        let tree = Tree::new();
        let log = tree.log().unwrap();
        let db = Connection::open(tree.path()).unwrap();
        db.execute_batch(case["sql"].as_str().unwrap()).unwrap();
        db.close().unwrap();
        let report = if case["reopen"].as_bool().unwrap() {
            tree.log().and_then(|log| log.report(1_000_000))
        } else {
            log.report(1_000_000)
        };
        let actual = report
            .ok()
            .map(|report| {
                serde_json::from_slice::<Value>(
                    &reverie_contracts::command_telemetry::encode_report(&report),
                )
                .unwrap()
            })
            .unwrap_or(Value::Null);
        if actual != case["report"] {
            failures.push((case["name"].clone(), actual, case["report"].clone()));
        }
    }
    assert!(
        failures.is_empty(),
        "actual Python SQLite mismatches: {failures:?}"
    );
}
#[test]
fn real_duplicate_conflict_eviction_and_expiration_keep_legacy_tables_and_principal() {
    let tree = Tree::new();
    let log = tree.log().unwrap();
    assert!(log.observe(&event(0, 127), 1_000_000).unwrap());
    assert!(log.observe(&event(0, 127), 1_000_000).unwrap());
    assert!(!log.observe(&event(0, 1), 1_000_000).unwrap());
    assert_eq!(log.report(1_000_000).unwrap().counts()[0].count(), 1);
    let db = Connection::open(tree.path()).unwrap();
    db.execute_batch("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<2047) INSERT INTO failures SELECT printf('00000000-0000-0000-0000-%012x',n),1000000,'11111111-1111-1111-1111-111111111111','hands','shell',127,'COMMAND_NOT_FOUND' FROM seq").unwrap();
    db.close().unwrap();
    assert!(log.observe(&event(2048, 127), 1_000_001).unwrap());
    let report = log.report(1_000_001).unwrap();
    assert_eq!(report.counts()[0].count(), 2048);
    assert_eq!(report.evicted(), 1);
    let boundary = log.report(1_000_001 + 7 * 86400).unwrap();
    assert_eq!(boundary.counts()[0].count(), 1);
    assert_eq!(boundary.expired(), 2047);
    let report = log.report(1_000_001 + 7 * 86400 + 1).unwrap();
    assert!(report.counts().is_empty());
    assert_eq!(report.expired(), 2048);
    let db = Connection::open(tree.path()).unwrap();
    let tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        tables,
        ["binding", "counters", "failures", "telemetry_origin"]
    );
    db.close().unwrap();
    assert_eq!(
        fs::metadata(tree.path()).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
#[test]
fn missing_replaced_hardlinked_and_foreign_binding_stores_never_fallback_create() {
    let tree = Tree::new();
    let log = tree.log().unwrap();
    fs::rename(tree.path(), tree.0.join("retained.sqlite")).unwrap();
    assert!(log.report(1_000_000).is_err());
    assert!(!tree.path().exists());
    fs::write(tree.path(), b"foreign unchanged").unwrap();
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o600)).unwrap();
    assert!(log.report(1_000_000).is_err());
    assert_eq!(fs::read(tree.path()).unwrap(), b"foreign unchanged");
    fs::remove_file(tree.path()).unwrap();
    fs::rename(tree.0.join("retained.sqlite"), tree.path()).unwrap();
    fs::hard_link(tree.path(), tree.0.join("alias")).unwrap();
    assert!(log.report(1_000_000).is_err());
    assert!(tree.log().is_err());
}
#[test]
fn actual_checked_close_failure_refuses_and_preserves_primary_plus_secondary() {
    let tree = Tree::new();
    let log = tree.log().unwrap();
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o644)).unwrap();
    crate::faults::STATE
        .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Data));
    let error = log.report(1_000_000).unwrap_err();
    crate::faults::reset();
    assert!(matches!(error, FailureStoreError::Finalized { .. }));
    assert!(error.is_uncertain());
    assert!(tree.path().exists());
}

thread_local! {pub(super) static FORGET_STATEMENT:std::cell::Cell<bool>=const{std::cell::Cell::new(false)};}
pub(super) fn before_close(db: &Connection) {
    if FORGET_STATEMENT.with(|flag| flag.replace(false)) {
        let statement = db.prepare("SELECT 1").unwrap();
        std::mem::forget(statement);
    }
}

#[test]
fn protected_existing_open_creates_neither_missing_hands_nor_missing_database() {
    let tree = Tree::new();
    let owner = LearningLogs::new();
    let directory = tree.0.join("hands");
    assert!(
        owner
            .open_existing(
                &directory,
                &tree.employee(),
                &[TelemetryKey::Shell],
                tree.uid()
            )
            .is_err()
    );
    assert!(!directory.exists());
    let existing = owner
        .open(
            &directory,
            &tree.employee(),
            &[TelemetryKey::Shell],
            tree.uid(),
        )
        .unwrap();
    drop(existing);
    fs::remove_file(tree.path()).unwrap();
    assert!(
        owner
            .open_existing(
                &directory,
                &tree.employee(),
                &[TelemetryKey::Shell],
                tree.uid()
            )
            .is_err()
    );
    assert!(!tree.path().exists());
    assert!(!owner.has_pending());
}
