use super::*;
use serde_json::{Value, json};

const ROOM: &str = "20000000-0000-0000-0000-000000000002";
const END: &str = "30000000-0000-0000-0000-000000000010";
const EARLIER: &str = "30000000-0000-0000-0000-000000000001";

fn frame() -> Value {
    json!({
        "captured_end": {"id": END, "at": 10, "sha256": "0".repeat(64)},
        "clock_ms": 3600 * 4 * 1000,
        "catalog": "[]",
        "read_only": false,
        "asked_to_remember": false,
        "checkpoint": null,
    })
}

fn job(turn: Value, capsule: Value) -> io::Result<Presentation> {
    let value = json!({"room": ROOM, "capsule": capsule, "turn": turn});
    execute(value.to_string().as_bytes())
}

#[test]
fn reminder_requires_elapsed_time_and_a_strictly_newer_cursor() {
    let mut turn = frame();
    let bootstrap = job(turn.clone(), Value::Null).unwrap().context.unwrap();
    assert!(bootstrap.text.contains("bootstrap entry"));
    assert!(!bootstrap.needs_reason);
    turn["checkpoint"] = json!({"id": 1, "end_at": 10.0, "turn_id": EARLIER, "committed_ms": 0});
    let due = job(turn.clone(), Value::Null).unwrap().context.unwrap();
    assert_eq!(due.previous_id, Some(1));
    assert!(due.text.contains("At least four hours"));
    assert!(!due.needs_reason);
    turn["checkpoint"]["turn_id"] = json!(END);
    let stale = job(turn.clone(), Value::Null).unwrap().context.unwrap();
    assert!(stale.needs_reason);
    turn["read_only"] = json!(true);
    let lookup = job(turn, Value::Null).unwrap().context.unwrap();
    assert!(lookup.text.contains("Read-only room journal"));
    assert!(!lookup.text.contains("At least four hours"));
    assert!(!lookup.needs_reason);
}

#[test]
fn recall_is_scoped_and_bounded_independently_of_the_prompt() {
    let mut capsule = json!({"status": "available", "scope": ROOM,
                             "omitted_or_source_changed": false, "entries": []});
    assert!(
        job(frame(), capsule.clone())
            .unwrap()
            .recall
            .contains("IDs + provenance")
    );
    capsule["scope"] = json!(EARLIER);
    let result = job(frame(), capsule).unwrap();
    assert!(result.recall.is_empty() && result.context.is_some());

    let mut too_long = frame();
    too_long["catalog"] = json!("雪".repeat(CONTEXT_CHARS));
    assert!(job(too_long, Value::Null).is_err());
}
