use super::{Fixture, ROOM, SOURCE, accepted, automatic_refused, member, set_messages};
use reverie_contracts::memory::channel::journal::JournalCommit;
use reverie_core::ids::ChatRoomId;
use rusqlite::Connection;
use serde_json::{Value, json, value::to_raw_value};
use std::{fs, path::Path, sync::Barrier, thread};

const LEGACY: &str = include_str!("journal_write_vectors.json");

pub(super) fn prepared(case: &Value) -> JournalCommit {
    let room = ChatRoomId::parse(ROOM).unwrap();
    JournalCommit::decode(
        &to_raw_value(&case["draft"]).unwrap(),
        &to_raw_value(&case["captured"]).unwrap(),
        &room,
    )
    .unwrap()
}

pub(super) fn vectors() -> Value {
    serde_json::from_str(LEGACY).unwrap()
}

pub(super) fn job(fixture: &Fixture, vectors: &Value, index: usize) -> Value {
    let messages = vectors["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["id"].as_str().unwrap().to_owned(), row.clone()))
        .collect::<serde_json::Map<_, _>>();
    set_messages(fixture, &Value::Object(messages));
    let mut input = vectors["cases"][index]["request"]
        .as_object()
        .unwrap()
        .clone();
    input.remove("now_ms");
    Value::Object(input)
}

fn read_state(path: &Path) -> Value {
    let db = Connection::open(path).unwrap();
    let read = |sql| {
        let text: String = db.query_row(sql, [], |row| row.get(0)).unwrap();
        serde_json::from_str::<Value>(&text).unwrap()
    };
    json!({
        "rows": read("SELECT json_group_array(json_object('id', id, 'turn_id', turn_id,
            'committed_ms', committed_ms, 'payload_hash', payload_hash,
            'payload', payload, 'end_at', end_at)) FROM (SELECT * FROM hands_journal ORDER BY id)"),
        "fts": read("SELECT json_group_array(json_object('rowid', rowid, 'text', text))
            FROM (SELECT rowid, text FROM hands_journal_fts ORDER BY rowid)"),
        "links": read("SELECT json_group_array(json_object('superseding_id', superseding_id,
            'target_id', target_id)) FROM (SELECT * FROM hands_journal_links ORDER BY superseding_id)"),
    })
}

#[test]
fn write_preserves_legacy_sqlite_payloads_replays_index_and_correction_links() {
    let legacy = vectors();
    let fixture = Fixture::new();
    let store = fixture.store();
    for case in legacy["cases"].as_array().unwrap() {
        let wire = &case["request"];
        let request = prepared(wire);
        let previous = wire["previous_id"].as_i64();
        let clock = wire["now_ms"].as_f64().unwrap();
        let receipt = store
            .commit_journal(&request, previous, clock)
            .unwrap()
            .unwrap();
        assert_eq!(
            receipt.entry_id,
            case["reply"]["entry_id"].as_i64().unwrap()
        );
        assert!(!receipt.replayed);
        let again = store
            .commit_journal(&request, previous, clock)
            .unwrap()
            .unwrap();
        assert!(again.replayed);
        assert_eq!(receipt.entry_id, again.entry_id);
    }
    store.close().unwrap();
    assert_eq!(
        read_state(&fixture.database()),
        json!({
            "rows": legacy["rows"], "fts": legacy["fts"], "links": legacy["links"]
        })
    );
    let id = legacy["cases"][1]["receipt"]["turn_id"].clone();
    let receipt = super::accepted(&fixture.automatic("journal_receipt", json!({"turn_id": id})));
    assert_eq!(receipt, legacy["cases"][1]["receipt"]);
}

#[test]
fn write_rolls_back_entry_and_index_on_failed_link_and_refuses_stale_checkpoint() {
    let fixture = Fixture::new();
    let legacy = vectors();
    let first = prepared(&legacy["cases"][0]["request"]);
    let second = prepared(&legacy["cases"][1]["request"]);
    let store = fixture.store();
    assert!(
        store
            .commit_journal(&first, None, 1000.0)
            .unwrap()
            .is_some()
    );
    let before = read_state(&fixture.database());
    let mut changed = legacy["cases"][0]["request"].clone();
    changed["draft"]["text"] = json!("Different account for the same turn.");
    assert!(
        store
            .commit_journal(&prepared(&changed), None, 1100.0)
            .unwrap()
            .is_none()
    );
    let mut missing = legacy["cases"][1]["request"].clone();
    missing["draft"]["annotations"]["related"] = json!([99]);
    assert!(
        store
            .commit_journal(&prepared(&missing), Some(1), 1100.0)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .commit_journal(&second, None, 1100.0)
            .unwrap()
            .is_none()
    );
    let db = Connection::open(fixture.database()).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_link BEFORE INSERT ON hands_journal_links
        BEGIN SELECT RAISE(ABORT, 'injected link failure'); END;",
    )
    .unwrap();
    db.close().unwrap();
    assert!(store.commit_journal(&second, Some(1), 1100.0).is_err());
    assert_eq!(read_state(&fixture.database()), before);
    let db = Connection::open(fixture.database()).unwrap();
    db.execute_batch("DROP TRIGGER reject_link").unwrap();
    db.close().unwrap();
    assert!(
        store
            .commit_journal(&second, Some(1), 1100.0)
            .unwrap()
            .is_some()
    );
    store.close().unwrap();
}

#[test]
fn concurrent_connections_claim_one_turn_once() {
    let fixture = Fixture::new();
    let request = prepared(&vectors()["cases"][0]["request"]);
    let first = fixture.store();
    let second = fixture.store();
    let start = Barrier::new(2);
    let pair = thread::scope(|scope| {
        let one = scope.spawn(|| {
            start.wait();
            first
                .commit_journal(&request, None, 1000.0)
                .unwrap()
                .unwrap()
        });
        start.wait();
        let two = second
            .commit_journal(&request, None, 1000.0)
            .unwrap()
            .unwrap();
        (one.join().unwrap(), two)
    });
    first.close().unwrap();
    second.close().unwrap();
    assert_eq!(pair.0.entry_id, pair.1.entry_id);
    assert_ne!(pair.0.replayed, pair.1.replayed);
    assert_eq!(
        read_state(&fixture.database())["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn live_commit_classifies_exact_source_refusal_and_leaves_no_database() {
    let legacy = vectors();
    let fixture = Fixture::new();
    let input = job(&fixture, &legacy, 0);
    for (mode, reason) in [
        ("exact-not-found", "source_unavailable"),
        ("exact-failed", ""),
    ] {
        fs::write(fixture.0.join("mode"), mode).unwrap();
        let output = fixture.automatic("journal_commit", input.clone());
        if reason.is_empty() {
            automatic_refused(&output);
        } else {
            assert_eq!(
                accepted(&output),
                json!({"status": "refused", "reason": reason})
            );
        }
        assert!(!fixture.database().exists());
    }
    fs::write(fixture.0.join("mode"), "").unwrap();
    let mut wrong_quote = input.clone();
    wrong_quote["draft"]["sources"][0]["quote"] = json!("not in the source");
    assert_eq!(
        accepted(&fixture.automatic("journal_commit", wrong_quote)),
        json!({"status": "refused", "reason": "quote_not_in_source"})
    );
    fs::write(fixture.0.join("mode"), "").unwrap();
    let mut latest = legacy["messages"][0].clone();
    latest["from"]["name"] = json!("Changed sender");
    let mut changed = json!({});
    changed[SOURCE] = latest;
    set_messages(&fixture, &changed);
    assert_eq!(
        accepted(&fixture.automatic("journal_commit", input)),
        json!({
            "status": "refused", "reason": "source_changed"
        })
    );
    assert!(!fixture.database().exists());
}

#[test]
fn live_commit_preserves_recoverable_receipt_after_membership_is_lost() {
    let legacy = vectors();
    let fixture = Fixture::new();
    let input = job(&fixture, &legacy, 0);
    fixture.rooms(json!([member()]));
    fs::write(fixture.0.join("mode"), "revoked").unwrap();
    automatic_refused(&fixture.automatic("journal_commit", input.clone()));
    fs::write(fixture.0.join("mode"), "").unwrap();
    let reply = accepted(&fixture.automatic("journal_receipt", json!({"turn_id": SOURCE})));
    assert_eq!(
        reply["payload_sha256"],
        legacy["cases"][0]["receipt"]["payload_sha256"]
    );
    assert_eq!(reply["entry_id"], 1);
    assert_eq!(
        accepted(&fixture.automatic("journal_commit", input)),
        legacy["cases"][0]["replay"]
    );
}
