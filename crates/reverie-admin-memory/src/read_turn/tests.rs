use super::*;

const ROOM: &str = "20000000-0000-0000-0000-000000000002";
const TURN: &str = "30000000-0000-0000-0000-000000000010";
const SOURCE: &str = "30000000-0000-0000-0000-000000000011";
const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn revision(id: &str, at: i64) -> Value {
    json!({"id": id, "at": at, "sha256": HASH})
}

fn capture() -> Value {
    json!({"room": ROOM, "end": revision(TURN, 10), "events": [revision(TURN, 10)],
           "coverage": "bounded-visible-messages; gaps are not claimed covered"})
}

fn phase(job: Value) -> Value {
    execute(job.to_string().as_bytes()).unwrap()
}

fn plan_call(tool: &str, args: Value, expanded: Value) -> Value {
    phase(
        json!({"phase": "plan", "tool": tool, "arguments": args.to_string(),
                 "captured_end": revision(TURN, 10), "expanded_sources": expanded}),
    )
}

fn result(request: Value, result: Value, captured: Value) -> Value {
    phase(json!({"phase": "settle", "request": request, "result": result, "captured": captured}))
}

#[test]
fn allows_two_distinct_source_expansions_and_refuses_override() {
    let expanded = json!([TURN, "30000000-0000-0000-0000-000000000012"]);
    let third = plan_call(
        "journal_source",
        json!({"message_id": SOURCE}),
        expanded.clone(),
    );
    assert_eq!(third["reply"]["reason"], "source_budget");
    let repeat = plan_call("journal_source", json!({"message_id": TURN}), expanded);
    assert_eq!(repeat["request"]["captured_end"], revision(TURN, 10));
    let override_room = plan_call(
        "journal_source",
        json!({"message_id": SOURCE, "room": ROOM}),
        json!([]),
    );
    assert_eq!(override_room["reply"]["reason"], INVALID);
}

#[test]
fn accepts_only_exact_bounded_and_unchanged_source_revisions() {
    let requested = plan_call("journal_source", json!({"message_id": SOURCE}), json!([]));
    let request = requested["request"].clone();
    let good = json!({"status": "available", "revision": revision(SOURCE, 5), "text": "visible"});
    let added = result(request.clone(), good.clone(), capture());
    assert_eq!(added["expanded_id"], SOURCE);
    assert_eq!(added["captured"]["end"], revision(TURN, 10));
    assert_eq!(
        added["captured"]["events"],
        json!([revision(TURN, 10), revision(SOURCE, 5)])
    );
    let mut changed = good.clone();
    changed["revision"]["sha256"] = json!("f".repeat(64));
    assert_eq!(
        result(request.clone(), changed, added["captured"].clone())["reply"]["reason"],
        INVALID
    );
    let mut future = good.clone();
    future["revision"]["at"] = json!(11);
    assert_eq!(
        result(request.clone(), future, capture())["reply"]["reason"],
        INVALID
    );
    let mut long = good;
    long["text"] = json!("雪".repeat(343));
    assert_eq!(result(request, long, capture())["reply"]["reason"], INVALID);
}

#[test]
fn receipts_bind_selection_and_map_omits_body_fields() {
    for (reference, reply) in [
        (
            json!("2"),
            json!({"status": "committed", "turn_id": TURN, "entry_id": 3}),
        ),
        (
            json!(TURN),
            json!({"status": "committed", "turn_id": SOURCE, "entry_id": 2}),
        ),
    ] {
        let planned = plan_call("journal_receipt", json!({"turn_id": reference}), json!([]));
        assert_eq!(
            result(planned["request"].clone(), reply, capture())["reply"]["reason"],
            INVALID
        );
    }
    let planned = plan_call("journal_map", json!({"query": ""}), json!([]));
    let view = json!({
        "status": "available", "scope": ROOM, "coverage": {"more": false},
        "entries": [{"id": 1, "text": "private-body", "currentness": "current",
                     "importance": "notable", "related": [], "provenance": "direct"}],
        "tags": [{"label": "Work", "count": 1, "entry_ids": [1], "body": "private-body"}],
        "edges": [],
    });
    let mapped = result(planned["request"].clone(), view.clone(), capture());
    assert_eq!(mapped["reply"]["status"], "available");
    assert!(!mapped.to_string().contains("private-body"));
    let mut foreign = view;
    foreign["scope"] = json!(SOURCE);
    assert_eq!(
        result(planned["request"].clone(), foreign, capture())["reply"]["reason"],
        INVALID
    );
}
