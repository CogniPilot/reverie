use reverie_contracts::{
    memory_documents::{BallotProposal, DocumentBody, SelfModelDraft},
    storage_identity::MetadataText,
};
use reverie_core::memory_documents::ballot_week;
fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/memory-documents-python.json")).unwrap()
}
fn points(value: &serde_json::Value) -> Vec<u32> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u32)
        .collect()
}
#[test]
fn actual_python_unicode_document_and_canonical_ballot_text_match() {
    for case in fixture()["documents"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        let body = DocumentBody::decode_json(raw).unwrap();
        assert_eq!(
            body.json_text().codepoints(),
            points(&case["normalPoints"]),
            "{raw}"
        );
        assert_eq!(body.as_json(), case["ascii"].as_str().unwrap().as_bytes());
        assert_eq!(
            body.checked_sql_text().is_ok(),
            case["scalar"].as_bool().unwrap()
        );
        let ballot = BallotProposal::decode_json(raw).unwrap();
        let result = ballot.sha256();
        assert_eq!(result.is_ok(), case["scalar"].as_bool().unwrap());
        if let Ok(hash) = result {
            assert_eq!(hash, case["sha256"].as_str().unwrap());
        }
    }
}
#[test]
fn actual_self_model_and_calendar_week_policies_match() {
    let fixture = fixture();
    for case in fixture["selfModels"].as_array().unwrap() {
        let result = SelfModelDraft::decode_json(case["raw"].as_str().unwrap()).and_then(|draft| {
            draft.prepare(
                &DocumentBody::decode_json(case["current"].as_str().unwrap()).unwrap(),
                &MetadataText::from_scalar_text(case["reason"].as_str().unwrap()),
            )
        });
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["raw"]
        );
        if let Ok(change) = result {
            assert_eq!(
                change.body().json_text().codepoints(),
                points(&case["bodyPoints"])
            );
        }
    }
    for case in fixture["weeks"].as_array().unwrap() {
        assert_eq!(
            ballot_week(case["now"].as_f64().unwrap()).unwrap(),
            case["week"].as_i64().unwrap()
        );
    }
}
#[test]
fn document_limits_count_python_characters_and_shared_unicode_emit_is_iterative() {
    let body = DocumentBody::decode_json(&format!("\"{}\"", "😀".repeat(99_998))).unwrap();
    assert!(body.checked_sql_text().is_ok());
    assert!(
        DocumentBody::decode_json(&format!("\"{}\"", "😀".repeat(99_999)))
            .unwrap()
            .checked_sql_text()
            .is_err()
    );
    let depth = 10_000;
    let raw = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
    assert_eq!(
        DocumentBody::decode_json(&raw)
            .unwrap()
            .json_text()
            .scalar_text()
            .unwrap(),
        raw
    );
}
#[test]
fn actual_budgeted_briefs_preserve_essentials_and_omit_private_profile_history() {
    use reverie_contracts::memory_documents::BriefRequest;
    for case in fixture()["briefs"].as_array().unwrap() {
        let profiles = case["profiles"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, body)| {
                (
                    name.clone(),
                    DocumentBody::decode_json(body.as_str().unwrap()).unwrap(),
                )
            })
            .collect();
        let result = BriefRequest::decode_json(case["raw"].as_str().unwrap())
            .and_then(|request| request.render(&profiles));
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["raw"]
        );
        if let Ok(rendered) = result {
            assert_eq!(rendered, case["rendered"].as_str().unwrap());
            assert!(!rendered.contains("PRIVATE_SENTINEL"));
        }
    }
}
