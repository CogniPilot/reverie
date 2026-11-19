use super::*;
use reverie_contracts::memory::channel::journal::canonical_journal_output;

fn legacy() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/support/journal_write_vectors.json"
    ))
    .unwrap()
}

fn request(phase: &str, payload: Value) -> Value {
    let input = json!({"phase": phase, "payload": payload});
    let result = execute(input.to_string().as_bytes()).unwrap();
    serde_json::from_slice(&serde_json::to_vec(&result).unwrap()).unwrap()
}

fn preparation(case: &Value) -> Value {
    json!({
        "room": case["request"]["captured"]["room"],
        "captured": case["request"]["captured"],
        "arguments": case["request"]["draft"].to_string(),
        "read_only": false,
        "needs_reason": false,
    })
}

fn key(case: &Value) -> Value {
    json!({
        "turn_id": case["receipt"]["turn_id"],
        "expected_hash": case["receipt"]["payload_sha256"],
    })
}

#[test]
fn preflight_preserves_legacy_payload_digests() {
    let legacy = legacy();
    for case in legacy["cases"].as_array().unwrap() {
        let plan = request("prepare", preparation(case));
        assert_eq!(
            plan,
            json!({"action": "commit", "key": key(case), "draft": case["request"]["draft"]})
        );
    }
}

#[test]
fn preflight_refuses_read_only_missing_reason_and_unseen_source_before_effect() {
    let legacy = legacy();
    let case = &legacy["cases"][0];
    let mut input = preparation(case);
    input["read_only"] = json!(true);
    input["needs_reason"] = json!(true);
    assert_eq!(
        request("prepare", input.clone())["reply"]["reason"],
        "read_only_request"
    );
    input["read_only"] = json!(false);
    assert_eq!(
        request("prepare", input.clone())["reply"]["reason"],
        NEEDS_REASON
    );
    let mut draft = case["request"]["draft"].clone();
    draft["annotations"]["reason"] = json!("receipt checked");
    input["arguments"] = json!(draft.to_string());
    assert_eq!(request("prepare", input.clone())["action"], "commit");
    draft["sources"][0]["id"] = json!("30000000-0000-0000-0000-000000000099");
    input["arguments"] = json!(draft.to_string());
    assert_eq!(request("prepare", input)["reply"]["reason"], INVALID);
}

#[test]
fn refusal_is_terminal_and_an_ambiguous_reply_only_requests_receipt() {
    let legacy = legacy();
    let case = &legacy["cases"][0];
    let key = key(case);
    let refused = request(
        "classify",
        json!({
            "key": key,
            "result": {"status": "refused", "reason": "source_changed"}
        }),
    );
    assert_eq!(refused["action"], "reply");
    assert_eq!(refused["reply"]["turn_id"], key["turn_id"]);
    assert!(
        refused["reply"]["reason"]
            .as_str()
            .unwrap()
            .starts_with("source_changed;")
    );
    for result in [
        Value::Null,
        json!({}),
        json!({"status": "unknown"}),
        json!({"status": "committed", "entry_id": true}),
    ] {
        assert_eq!(
            request("classify", json!({"key": key, "result": result})),
            json!({"action": "receipt"})
        );
    }
    let committed = request("classify", json!({"key": key, "result": case["reply"]}));
    assert_eq!(committed["reply"]["turn_id"], key["turn_id"]);
    assert_eq!(committed["reply"]["entry_id"], case["reply"]["entry_id"]);
    assert_eq!(committed["previous_id"], case["reply"]["entry_id"]);
}

#[test]
fn committed_reply_starts_with_a_runnable_receipt_command() {
    let legacy = legacy();
    let case = &legacy["cases"][0];
    let key = key(case);
    let committed = request("classify", json!({"key": key, "result": case["reply"]}));
    let reply = &committed["reply"];
    let shown = canonical_journal_output(reply).unwrap();
    let command = format!("receipt {}", key["turn_id"].as_str().unwrap());
    assert!(shown.starts_with(&format!("{{\"check_with\":{command:?},")));
    assert!(shown.chars().count() <= crate::turn_tool::RESULT_CHARS);
    let invoke = json!({
        "phase": "invoke", "name": "journal", "read_only": false,
        "state": {"calls": 0, "help_shown": false},
        "arguments": json!({"command": reply["check_with"]}).to_string(),
    });
    let dispatch = crate::turn_tool::execute(invoke.to_string().as_bytes()).unwrap();
    let routed: Value = serde_json::from_str(dispatch.get()).unwrap();
    assert_eq!(
        routed["dispatch"],
        json!({"name": "journal_receipt", "arguments": {"turn_id": key["turn_id"]}}),
    );
}

#[test]
fn recovery_only_confirms_exact_positive_receipts_and_discards_unexpected_fields() {
    let legacy = legacy();
    let case = &legacy["cases"][0];
    let key = key(case);
    let mut receipt = case["receipt"].clone();
    receipt["text"] = json!("fixture body");
    let settled = request("recover", json!({"key": key, "result": receipt}));
    assert_eq!(settled["action"], "reply");
    assert_eq!(settled["previous_id"], receipt["entry_id"]);
    assert_eq!(settled["reply"]["status"], "committed");
    assert_eq!(settled["reply"]["write_retried"], false);
    assert_eq!(settled["reply"]["recovered_after_unknown"], true);
    assert!(settled["reply"].get("text").is_none());

    for (field, replacement) in [
        ("turn_id", json!("30000000-0000-0000-0000-000000000099")),
        ("payload_sha256", json!("0".repeat(64))),
        ("entry_id", json!(true)),
        ("entry_id", json!(1.0)),
        ("entry_id", json!(0)),
        ("committed_ms", json!(-1)),
        ("committed_ms", json!("1000")),
        ("status", json!("not_found")),
    ] {
        let mut other = receipt.clone();
        other[field] = replacement;
        let unresolved = request(
            "recover",
            json!({"key": key, "result": other, "failure": "timeout"}),
        );
        assert_eq!(unresolved["reply"]["status"], "unknown", "{field}");
        assert_eq!(unresolved["reply"]["failure"], "timeout");
        assert!(unresolved.get("previous_id").is_none());
    }
    let conflict = request(
        "recover",
        json!({"key": key, "result": {"status": "conflict"}}),
    );
    assert_eq!(conflict["reply"]["reason"], "operation_payload_conflict");
    let missing = request("recover", json!({"key": key, "result": null}));
    assert_eq!(missing["reply"]["status"], "unknown");
}
