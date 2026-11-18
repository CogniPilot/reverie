use super::{Fixture, accepted, automatic_refused, journal_write, set_messages};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::fs;

const LEGACY: &str = include_str!("journal_read_vectors.json");

fn seed(fixture: &Fixture) -> Value {
    let vectors = journal_write::vectors();
    journal_write::job(fixture, &vectors, 0);
    let store = fixture.store();
    for case in vectors["cases"].as_array().unwrap() {
        let request = &case["request"];
        let commit = journal_write::prepared(request);
        let receipt = store
            .commit_journal(
                &commit,
                request["previous_id"].as_i64(),
                request["now_ms"].as_f64().unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            receipt.entry_id,
            case["reply"]["entry_id"].as_i64().unwrap()
        );
    }
    store.close().unwrap();
    vectors
}

#[test]
fn projections_match_old_recall_and_historical_view() {
    let fixture = Fixture::new();
    seed(&fixture);
    let legacy: Value = serde_json::from_str(LEGACY).unwrap();
    let before = fs::read(fixture.database()).unwrap();
    for case in legacy["cases"].as_array().unwrap() {
        let query = &case["query"];
        let reply = match case["kind"].as_str().unwrap() {
            "page" => accepted(&fixture.automatic(
                "journal_view",
                json!({
                    "query": query, "as_of_ms": case["as_of_ms"],
                }),
            )),
            "recall" if case["compact"] == true => {
                let status =
                    accepted(&fixture.automatic("journal_status", json!({"query": query})));
                assert_eq!(status["checkpoint"], legacy["checkpoint"]);
                status["recall"].clone()
            }
            "recall" => accepted(&fixture.automatic("journal_recall", json!({"query": query}))),
            _ => unreachable!(),
        };
        assert_eq!(reply, case["reply"], "legacy case {case}");
    }
    assert_eq!(fs::read(fixture.database()).unwrap(), before);
}

#[test]
fn changed_source_matches_legacy_omission_and_unresolved_correction() {
    let fixture = Fixture::new();
    let vectors = seed(&fixture);
    let legacy: Value = serde_json::from_str(LEGACY).unwrap();
    let edited = &legacy["modified_source"];
    let mut messages: serde_json::Map<_, _> = vectors["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["id"].as_str().unwrap().to_owned(), row.clone()))
        .collect();
    messages.insert(
        edited["id"].as_str().unwrap().to_owned(),
        edited["message"].clone(),
    );
    set_messages(&fixture, &Value::Object(messages));
    let view = accepted(&fixture.automatic("journal_view", json!({})));
    assert_eq!(view, edited["view"]);
    let recall = accepted(&fixture.automatic("journal_recall", json!({"query": "silver"})));
    assert_eq!(recall, edited["recall"]);
}

#[test]
fn fresh_read_does_not_create_database_and_revocation_withholds_result() {
    let fixture = Fixture::new();
    let status = accepted(&fixture.automatic("journal_status", json!({"query": " "})));
    assert_eq!(status["checkpoint"], Value::Null);
    assert_eq!(status["recall"]["status"], "unavailable");
    let empty = accepted(&fixture.automatic("journal_view", json!({})));
    assert_eq!(empty["coverage"]["examined"], 0);
    assert_eq!(empty["cursor"], Value::Null);
    assert!(!fixture.database().exists());
    automatic_refused(&fixture.automatic("journal_view", json!({"before_id": 0})));

    seed(&fixture);
    fs::write(fixture.0.join("calls"), "0").unwrap();
    fs::write(fixture.0.join("mode"), "second-membership-revoked").unwrap();
    automatic_refused(&fixture.automatic("journal_view", json!({})));
}

#[test]
fn view_cursor_keeps_window_ceiling_after_a_new_write() {
    let fixture = Fixture::new();
    seed(&fixture);
    let db = Connection::open(fixture.database()).unwrap();
    for id in 3..7 {
        db.execute(
            "INSERT INTO hands_journal(id,turn_id,committed_ms,payload_hash,payload,end_at)
             SELECT ?1, ?2, committed_ms, payload_hash, payload, end_at FROM hands_journal WHERE id=2",
            (id, format!("50000000-0000-0000-0000-{id:012}")),
        ).unwrap();
        if id == 5 {
            let first = accepted(&fixture.automatic("journal_view", json!({})));
            assert_eq!(first["coverage"]["examined"], 4);
            assert_eq!(first["coverage"]["more"], true);
            assert_eq!(first["cursor"], json!({"snapshot_id": 5, "before_id": 2}));
        }
    }
    db.close().unwrap();
    let next =
        accepted(&fixture.automatic("journal_view", json!({"snapshot_id": 5, "before_id": 2})));
    assert_eq!(next["entries"].as_array().unwrap().len(), 1);
    assert_eq!(next["entries"][0]["id"], 1);
    assert_eq!(next["coverage"]["more"], false);
}

fn distinct_entry(entry: u32, messages: &mut serde_json::Map<String, Value>) -> Value {
    use reverie_contracts::memory::channel::journal::{canonical_journal_output, journal_digest};
    let mut sources = Vec::new();
    let mut events = Vec::new();
    for offset in 1..=4 {
        let n = entry * 10 + offset;
        let id = format!("50000000-0000-0000-0000-{n:012}");
        let payload = json!({"id": id, "at": n, "roomId": super::ROOM, "text": "A quoted source.", "from": null});
        let digest = journal_digest(&canonical_journal_output(&payload).unwrap());
        let mut message = payload;
        message["phoneWake"] = json!(true);
        messages.insert(id.clone(), message);
        sources.push(json!({"id": id, "quote": "quoted source"}));
        events.push(json!({"id": id, "at": n, "sha256": digest.as_str()}));
    }
    json!({
        "draft": {"text": "A bounded four-source entry.", "tags": ["lesson"], "sources": sources},
        "captured": {"room": super::ROOM, "end": events[3], "events": events,
                     "coverage": "bounded-visible-messages; gaps are not claimed covered"}
    })
}

#[test]
fn view_omits_whole_entry_once_live_source_budget_is_exhausted() {
    let fixture = Fixture::new();
    let mut messages = serde_json::Map::new();
    let store = fixture.store();
    for entry in 1..=4 {
        let wire = distinct_entry(entry, &mut messages);
        let predecessor = (entry > 1).then_some(i64::from(entry - 1));
        assert!(
            store
                .commit_journal(&journal_write::prepared(&wire), predecessor, 1000.0)
                .unwrap()
                .is_some()
        );
    }
    store.close().unwrap();
    set_messages(&fixture, &Value::Object(messages));
    let view = accepted(&fixture.automatic("journal_view", json!({})));
    let ids = view["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, [4, 3, 2]);
    assert_eq!(view["coverage"]["examined"], 4);
    assert_eq!(view["coverage"]["omitted_or_source_changed"], true);
}
