use super::super::{operations, validate};
use super::*;
use rusqlite::Connection;
use std::os::unix::fs::{PermissionsExt, symlink};

#[test]
fn opens_and_extends_the_original_sqlite_contract() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    ledger.db.execute_batch(include_str!("legacy.sql")).unwrap();
    let target = Binding {
        employee_id: "employee.a".to_owned(),
        goal_id: "goal:a".to_owned(),
        session_id: "session-a".to_owned(),
        ..binding("base")
    };
    let raw: String = ledger
        .db
        .query_row(
            "SELECT events.body FROM attempts JOIN events ON attempts.id=events.attempt
         WHERE attempts.key='key-1000' AND sequence=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let legacy: Value = serde_json::from_str(&raw).unwrap();
    let replay = reserve(&mut ledger, &target, "key-1000", 1051).unwrap();
    assert_eq!(replay, json!({"replayed":true,"receipt":legacy}));
    let alert = reserve(&mut ledger, &target, "blocked", 1052).unwrap();
    assert_eq!(alert["replayed"], true);
    assert_eq!(alert["receipt"]["blockedUntilMs"], 1801000);
    assert_eq!(alert["receipt"]["createdAtMs"], 1030);
    let pending = restart(&mut ledger, 1053).unwrap();
    assert_eq!(pending.as_array().unwrap().len(), 1);
    assert_eq!(pending[0]["sequence"], 3);
    assert_eq!(pending[0]["binding"]["transition_sequence"], 8);
    ledger.close().unwrap();
    assert_eq!(restart(&mut fixture.ledger(), 1054).unwrap(), json!([]));
}

#[test]
fn rejects_event_body_corruption_before_replay_or_new_reservation() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    let target = binding("a");
    let original = reserve(&mut ledger, &target, "request", 1000).unwrap()["receipt"].clone();
    for (key, bad) in [
        ("extra", json!("synthetic")),
        ("schema_version", json!(true)),
        ("automaticAction", json!("SEND")),
        ("receiptId", json!("0".repeat(32))),
        ("attemptId", json!("0".repeat(32))),
        ("sequence", json!(true)),
        ("sequence", json!(2)),
        ("state", json!("REFUSED")),
        ("reason", json!("UNKNOWN")),
        ("createdAtMs", json!(999)),
        ("createdAtMs", json!(1001)),
        ("binding", json!({"goal_generation":2})),
    ] {
        let mut modified = original.clone();
        modified[key] = bad;
        assert_bad_event(&mut ledger, &target, &modified.to_string());
    }
    let duplicate = original.to_string().replacen(
        "\"schema_version\":1",
        "\"schema_version\":1,\"schema_version\":999",
        1,
    );
    for invalid in [duplicate.as_str(), "NaN", "[]", "\"text\"", "{"] {
        assert_bad_event(&mut ledger, &target, invalid);
    }
}

fn assert_bad_event(ledger: &mut Ledger, target: &Binding, raw: &str) {
    rewrite(&ledger.db, "events", "UPDATE events SET body=?", raw);
    assert_eq!(
        reserve(ledger, target, "request", 1001).err(),
        Some(Error::StoreUnavailable)
    );
    assert_eq!(
        reserve(ledger, &binding("b"), "other", 1001).err(),
        Some(Error::StoreUnavailable)
    );
}

#[test]
fn refuses_inconsistent_attempt_columns_and_transition_chain_fingerprints() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    let target = binding("a");
    let original = reserve(&mut ledger, &target, "request", 1000).unwrap()["receipt"].clone();
    for (column, correct) in [
        ("employee", &target.employee_id),
        ("goal", &target.goal_id),
        ("session", &target.session_id),
    ] {
        let change = format!("UPDATE attempts SET {column}=?");
        rewrite(&ledger.db, "attempts", &change, "wrong");
        assert_eq!(
            reserve(&mut ledger, &target, "request", 1001).err(),
            Some(Error::StoreUnavailable)
        );
        rewrite(&ledger.db, "attempts", &change, correct);
    }
    transition(
        &mut ledger,
        &original,
        State::Submitted,
        Reason::SubmissionConfirmed,
        "submit",
        1001,
    )
    .unwrap();
    rewrite(
        &ledger.db,
        "events",
        "UPDATE events SET fingerprint=? WHERE sequence=2",
        &"0".repeat(64),
    );
    assert_eq!(
        restart(&mut ledger, 1002).err(),
        Some(Error::StoreUnavailable)
    );
}

#[test]
fn budget_reports_require_closed_fields_and_backing_attempts() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    let target = binding("a");
    for now in [1000, 1010, 1020] {
        refused(&mut ledger, &target, &format!("key-{now}"), now);
    }
    let report = reserve(&mut ledger, &target, "too-many", 1030).unwrap()["receipt"].clone();
    for (key, bad) in [
        ("subject", json!("other")),
        ("extra", json!("synthetic")),
        ("blockedUntilMs", json!(true)),
        ("blockedUntilMs", json!(1801001)),
    ] {
        let mut modified = report.clone();
        modified[key] = bad;
        rewrite(
            &ledger.db,
            "alerts",
            "UPDATE alerts SET body=?",
            &modified.to_string(),
        );
        assert_eq!(
            reserve(&mut ledger, &target, "again", 1040).err(),
            Some(Error::StoreUnavailable)
        );
    }
    rewrite(
        &ledger.db,
        "alerts",
        "UPDATE alerts SET body=?",
        &report.to_string(),
    );
    ledger
        .db
        .execute_batch("DROP TRIGGER attempts_no_update; UPDATE attempts SET issued=issued+1;")
        .unwrap();
    assert_eq!(
        reserve(&mut ledger, &target, "again", 1040).err(),
        Some(Error::StoreUnavailable)
    );
}

fn rewrite(db: &Connection, table: &str, change: &str, value: &str) {
    let trigger = format!("{table}_no_update");
    db.execute_batch(&format!("DROP TRIGGER {trigger}"))
        .unwrap();
    db.execute(change, [value]).unwrap();
    db.execute_batch(&format!(
        "CREATE TRIGGER {trigger} BEFORE UPDATE ON {table} BEGIN SELECT RAISE(ABORT,'immutable'); END"
    )).unwrap();
}

#[test]
fn partial_semantic_refusal_keeps_only_the_clock_floor() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    let result = ledger.transact(5000, |db, history| {
        operations::reserve(
            db,
            history,
            Reserve {
                binding: binding("a"),
                key: "fixture".to_owned(),
                now: 5000,
            },
        )?;
        Err::<(), _>(Error::StoreFull)
    });
    assert_eq!(result, Err(Error::StoreFull));
    ledger.close().unwrap();
    let mut ledger = fixture.ledger();
    let history = validate::load(&ledger.db).unwrap();
    assert!(history.latest.is_empty());
    assert_eq!(history.floor, 5000);
    assert_eq!(
        reserve(&mut ledger, &binding("a"), "older", 4999).err(),
        Some(Error::ClockReversed)
    );
    assert_eq!(
        reserve(&mut ledger, &binding("a"), "fixture", 5000).unwrap()["replayed"],
        false
    );
}

#[test]
fn failed_restart_append_rolls_back_all_preceding_rows_and_the_clock() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    for name in ["a", "b"] {
        reserve(&mut ledger, &binding(name), "request", 1000).unwrap();
    }
    ledger
        .db
        .execute_batch(
            "CREATE TRIGGER refuse_second BEFORE INSERT ON events
         WHEN NEW.state='UNCERTAIN' AND EXISTS(SELECT 1 FROM events WHERE state='UNCERTAIN')
         BEGIN SELECT RAISE(ABORT,'private fault'); END",
        )
        .unwrap();
    assert_eq!(
        restart(&mut ledger, 5000).err(),
        Some(Error::StoreUnavailable)
    );
    ledger
        .db
        .execute_batch("DROP TRIGGER refuse_second")
        .unwrap();
    let rows = restart(&mut ledger, 4000).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 2);
    assert!(
        rows.as_array()
            .unwrap()
            .iter()
            .all(|row| row["sequence"] == 2)
    );
}

#[test]
fn refuses_corrupt_clock_schema_and_database_and_retains_the_original_bytes() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    ledger
        .db
        .execute_batch("UPDATE ledger_meta SET clock_floor='invalid'")
        .unwrap();
    assert_eq!(
        restart(&mut ledger, 1002).err(),
        Some(Error::StoreUnavailable)
    );
    ledger
        .db
        .execute_batch(
            "UPDATE ledger_meta SET clock_floor=0; ALTER TABLE attempts ADD COLUMN unexpected TEXT",
        )
        .unwrap();
    assert_eq!(
        restart(&mut ledger, 1002).err(),
        Some(Error::StoreUnavailable)
    );
    ledger.close().unwrap();
    fs::write(&fixture.file, b"damaged contents").unwrap();
    fs::write(
        fixture.root.join("owner ledger.sqlite.bak"),
        b"no backup authority",
    )
    .unwrap();
    assert_eq!(
        Ledger::open(&fixture.file).err(),
        Some(Error::StoreUnavailable)
    );
    assert_eq!(fs::read(&fixture.file).unwrap(), b"damaged contents");
}

#[test]
fn refuses_links_modes_and_replaced_file_or_directory_identity() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    let link = fixture.root.join("link");
    symlink(&fixture.file, &link).unwrap();
    assert_eq!(Ledger::open(&link).err(), Some(Error::CustodyInvalid));
    fs::remove_file(&link).unwrap();
    fs::hard_link(&fixture.file, &link).unwrap();
    assert_eq!(
        restart(&mut ledger, 1000).err(),
        Some(Error::CustodyInvalid)
    );
    fs::remove_file(&link).unwrap();
    fs::set_permissions(&fixture.file, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        restart(&mut ledger, 1000).err(),
        Some(Error::CustodyInvalid)
    );
    fs::set_permissions(&fixture.file, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        restart(&mut ledger, 1000).err(),
        Some(Error::CustodyInvalid)
    );
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::rename(&fixture.file, &link).unwrap();
    fixture.ledger().close().unwrap();
    assert_eq!(
        restart(&mut ledger, 1000).err(),
        Some(Error::CustodyInvalid)
    );
}
