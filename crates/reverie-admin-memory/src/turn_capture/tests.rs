use super::*;
use serde_json::{Value, json};

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/support/journal_capture_vectors.json"
    ))
    .unwrap()
}

#[test]
fn source_snapshots_match_the_legacy_revisions_and_tie_order() {
    let vectors = vectors();
    for case in vectors["snapshots"].as_array().unwrap() {
        let input = json!({
            "room": case["room"],
            "history": case["history"],
            "message": case["message"],
        });
        let result = execute(input.to_string().as_bytes());
        if let Some(expected) = case.get("snapshot") {
            let result = result.unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
            let snapshot: Value = serde_json::from_str(result.captured.get()).unwrap();
            assert_eq!(&snapshot, expected, "{}", case["name"]);
        } else {
            assert!(result.is_err(), "{}", case["name"]);
        }
    }
}

#[test]
fn request_guards_recognize_legacy_word_boundaries_and_unicode() {
    let vectors = vectors();
    for case in vectors["intent"].as_array().unwrap() {
        let text = case["message"]["text"].as_str().unwrap_or_default();
        assert_eq!(
            read_only(text),
            case["read_only"].as_bool().unwrap(),
            "{text}"
        );
        assert_eq!(
            asked_to_remember(text),
            case["asks_to_remember"].as_bool().unwrap(),
            "{text}"
        );
    }
}

#[test]
fn catalog_uses_selected_room_evidence_and_bounded_unicode_excerpts() {
    let current = "30000000-0000-0000-0000-000000000003";
    let earlier = "30000000-0000-0000-0000-000000000001";
    let room = "20000000-0000-0000-0000-000000000002";
    let foreign = "20000000-0000-0000-0000-000000000008";
    let text = "雪".repeat(400);
    let input = json!({
        "room": room,
        "message": {"id": current, "at": 3, "roomId": room, "text": text},
        "history": [
            {"id": earlier, "at": 1.25, "roomId": room, "text": "in this room"},
            {"id": earlier, "at": 2, "roomId": foreign, "text": "foreign text"},
        ],
    });
    let result = execute(input.to_string().as_bytes()).unwrap();
    let catalog: Value = serde_json::from_str(&result.catalog).unwrap();
    assert_eq!(
        catalog,
        json!([
            {"id": earlier, "at": 1.25, "excerpt": "in this room"},
            {"id": current, "at": 3, "excerpt": "雪".repeat(160)},
        ])
    );
    assert_eq!(result.query, "雪".repeat(QUERY_CHARS));
    assert!(!result.read_only && !result.asked_to_remember);
}
