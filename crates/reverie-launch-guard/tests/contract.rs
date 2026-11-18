use reverie_contracts::launch_guard::{Receipt, Replay, ReplayError, Snapshot};
use serde_json::{Value, json};

fn example() -> Value {
    serde_json::from_slice(include_bytes!("../../../examples/launch-guard-input.json")).unwrap()
}

fn decode(value: &Value) -> Snapshot {
    Snapshot::decode(&serde_json::to_vec(value).unwrap()).unwrap()
}

fn receipt(value: &Value) -> Value {
    serde_json::from_slice(&decode(value).evaluate().bytes()).unwrap()
}

fn refuse(value: &Value) {
    assert!(Snapshot::decode(&serde_json::to_vec(value).unwrap()).is_err());
}

#[test]
fn synthetic_cases_keep_the_legacy_result_and_both_digests() {
    let cases: Vec<Value> = serde_json::from_slice(include_bytes!("fixtures/cases.json")).unwrap();
    assert_eq!(cases.len(), 10);
    for case in cases {
        let snapshot = json!({"request": case["request"], "now_ms": case["now_ms"]});
        let bytes = decode(&snapshot).evaluate().bytes();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["code"], case["expected_code"], "{}", case["name"]);
        assert_eq!(value["data"]["result"], case["expected_result"]);
        assert_eq!(
            value["data"]["snapshotSha256"],
            case["expected_snapshot_sha256"]
        );
        assert_eq!(value["receiptId"], case["expected_receipt_id"]);
        assert_eq!(Receipt::decode(&bytes).unwrap().bytes(), bytes);
    }
}

#[test]
fn v1_schema_and_receipt_have_the_same_closed_fields() {
    let schema: Value = serde_json::from_slice(include_bytes!(
        "../../../schemas/launch-guard-receipt-v1.json"
    ))
    .unwrap();
    let value = receipt(&example());
    let keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
    let required: Vec<String> = serde_json::from_value(schema["required"].clone()).unwrap();
    let properties: Vec<_> = schema["properties"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(keys, required);
    assert_eq!(keys, properties);
    assert_eq!(schema["additionalProperties"], false);
    let data = &schema["properties"]["data"];
    let mut required: Vec<String> = serde_json::from_value(data["required"].clone()).unwrap();
    required.sort();
    let keys: Vec<_> = value["data"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, required);
    assert_eq!(data["additionalProperties"], false);
}

#[test]
fn caller_metadata_bounds_and_nullable_fields_fail_closed() {
    for (field, value) in [
        ("goalGeneration", json!(true)),
        ("goalGeneration", json!(0)),
        ("goalGeneration", json!(1.0)),
        ("goalGeneration", json!(9_007_199_254_740_992_u64)),
        ("schema_version", json!(2)),
        ("goalId", json!("/private/file")),
        ("goalState", json!("unknown")),
        ("goId", json!("other")),
        ("rooms", json!([])),
        ("rooms", json!(["room-1", "room-1"])),
        ("cursor", json!({"room-1": -1})),
        ("cursor", json!({"room-1": 10, "other-room": 1})),
        ("decisionId", json!("unpaired")),
    ] {
        let mut candidate = example();
        candidate["request"][field] = value;
        refuse(&candidate);
    }
    let mut candidate = example();
    candidate["request"]
        .as_object_mut()
        .unwrap()
        .remove("decisionId");
    refuse(&candidate);
    let mut candidate = example();
    let message = candidate["request"]["source"]["messages"][0].clone();
    candidate["request"]["source"]["messages"] = json!([message, message]);
    refuse(&candidate);
}

#[test]
fn refuses_oversized_collections_and_distinct_duplicate_message_positions() {
    let mut input = example();
    let room_names: Vec<_> = (0..17).map(|index| format!("room-{index}")).collect();
    input["request"]["rooms"] = json!(room_names);
    input["request"]["cursor"] = Value::Object(
        room_names
            .into_iter()
            .map(|name| (name, json!(0)))
            .collect(),
    );
    refuse(&input);
    let mut input = example();
    let fixture = input["request"]["source"]["messages"][0].clone();
    let messages: Vec<_> = (1..=257)
        .map(|index| {
            let mut message = fixture.clone();
            message["id"] = json!(format!("message-{index}"));
            message["sequence"] = json!(index);
            message
        })
        .collect();
    input["request"]["source"]["messages"] = json!(messages);
    refuse(&input);
    let mut other = fixture.clone();
    other["id"] = json!("another-id");
    input["request"]["source"]["messages"] = json!([fixture, other]);
    refuse(&input);
}

#[test]
fn a_new_go_reference_and_an_unbound_user_message_are_distinct() {
    let mut input = example();
    let message = &mut input["request"]["source"]["messages"][0];
    message["goId"] = json!("go-1");
    assert_eq!(receipt(&input)["code"], "GUARD_UNREAD_INSTRUCTION");
    let message = &mut input["request"]["source"]["messages"][0];
    message["roomId"] = json!("unbound-room");
    message["authorRole"] = json!("USER");
    message["mentionsLauncher"] = json!(true);
    assert_eq!(receipt(&input)["code"], "GUARD_PASS");
}

#[test]
fn privacy_fields_are_rejected_at_every_request_level() {
    for path in ["/request", "/request/source", "/request/source/messages/0"] {
        for field in [
            "prompt",
            "output",
            "pane",
            "argv",
            "env",
            "credential",
            "checkpoint",
            "path",
        ] {
            let mut candidate = example();
            candidate.pointer_mut(path).unwrap()[field] = json!("synthetic private fixture");
            refuse(&candidate);
        }
    }
}

#[test]
fn generation_state_and_time_boundaries_preserve_refusal_priority() {
    let mut value = example();
    value["request"]["currentSessionGeneration"] = json!(2);
    value["request"]["goalState"] = json!("DONE");
    value["request"]["source"]["complete"] = json!(false);
    assert_eq!(receipt(&value)["code"], "GUARD_GEN_CHANGED");
    value["request"]["currentSessionGeneration"] = json!(1);
    for state in ["READY", "HOLD", "REVIEW", "DONE", "NO_GO", "CANCELLED"] {
        value["request"]["goalState"] = json!(state);
        assert_eq!(receipt(&value)["code"], "GUARD_STATE_NOT_ACTIVE");
    }
    let mut value = example();
    value["now_ms"] = json!(105_000);
    assert_eq!(receipt(&value)["code"], "GUARD_PASS");
    value["now_ms"] = json!(105_001);
    assert_eq!(receipt(&value)["code"], "GUARD_API_UNAVAILABLE");
    value["now_ms"] = json!(99_999);
    assert_eq!(receipt(&value)["code"], "GUARD_API_UNAVAILABLE");
    value["now_ms"] = json!(100_000);
    value["request"]["source"]["messages"][0]["atMs"] = json!(100_001);
    assert_eq!(receipt(&value)["code"], "GUARD_API_UNAVAILABLE");
}

#[test]
fn replay_keeps_the_original_stamp_and_bounds_new_keys() {
    let mut replay = Replay::default();
    let mut value = example();
    let first = replay.evaluate(&decode(&value)).unwrap().bytes();
    value["now_ms"] = json!(100_001);
    assert_eq!(replay.evaluate(&decode(&value)).unwrap().bytes(), first);
    let mut changed = value.clone();
    changed["request"]["source"]["complete"] = json!(false);
    assert!(matches!(
        replay.evaluate(&decode(&changed)),
        Err(ReplayError::Conflict)
    ));
    for index in 1..256 {
        changed["request"]["idempotencyKey"] = json!(format!("new-{index}"));
        replay.evaluate(&decode(&changed)).unwrap();
    }
    changed["request"]["idempotencyKey"] = json!("over-capacity");
    assert!(matches!(
        replay.evaluate(&decode(&changed)),
        Err(ReplayError::Full)
    ));
    assert_eq!(replay.evaluate(&decode(&value)).unwrap().bytes(), first);
}

#[test]
fn paired_decision_fields_and_receipt_tampering_keep_the_exact_abi() {
    let mut input = example();
    input["request"]["decisionId"] = json!("decision-1");
    input["request"]["decisionGeneration"] = json!(3);
    let bytes = decode(&input).evaluate().bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["decisionId"], "decision-1");
    assert_eq!(value["decisionGeneration"], 3);
    assert_eq!(Receipt::decode(&bytes).unwrap().bytes(), bytes);
    for (field, replacement) in [
        ("employeeId", json!("changed")),
        ("schema_version", json!(2)),
        ("code", json!("FREE_TEXT")),
        ("prompt", json!("synthetic-private")),
        ("receiptId", json!("0".repeat(64))),
    ] {
        let mut altered = value.clone();
        altered[field] = replacement;
        assert!(Receipt::decode(&serde_json::to_vec(&altered).unwrap()).is_err());
    }
}
