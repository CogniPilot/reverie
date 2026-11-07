//! Actual legacy journal helper and Python-str vectors. No API calls or grants.
use reverie_contracts::memory_cli::{
    JournalEntries, JournalReplyError, JournalSaveData, MemoryRequest, OutputPolicy,
};
use reverie_core::PythonTextRef;
use serde_json::{Value, json};
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/memory-cli-python-interop.json")).unwrap()
}
fn points(value: &Value) -> Vec<u32> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| u32::try_from(value.as_u64().unwrap()).unwrap())
        .collect()
}
#[test]
fn actual_python_save_arguments_missing_fields_shell_copy_and_query_text() {
    let data = corpus();
    for case in data["saves"].as_array().unwrap() {
        let raw = case["request"].as_str().unwrap();
        let MemoryRequest::Remember { request } =
            MemoryRequest::decode(PythonTextRef::from_scalar_text(raw)).unwrap()
        else {
            panic!("{raw}")
        };
        assert_eq!(
            request
                .arguments()
                .iter()
                .map(|value| value.codepoints().to_vec())
                .collect::<Vec<_>>(),
            case["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(points)
                .collect::<Vec<_>>(),
            "{raw}"
        );
        assert_eq!(
            request.copy_command().codepoints(),
            points(&case["copy"]),
            "{raw}"
        );
        assert_eq!(json!(request.missing()), case["missing"], "{raw}");
    }
    for case in data["queries"].as_array().unwrap() {
        let raw = case["request"].as_str().unwrap();
        let MemoryRequest::Recall { query, .. } =
            MemoryRequest::decode(PythonTextRef::from_scalar_text(raw)).unwrap()
        else {
            panic!("{raw}")
        };
        assert_eq!(query.codepoints(), points(&case["query"]), "{raw}");
    }
}
#[test]
fn wire_requests_do_not_select_configuration_or_bypass_scope() {
    for raw in [
        r#"{"action":"recall","private":true,"project":"p"}"#,
        r#"{"action":"recall","private":true,"channel":"work"}"#,
        r#"{"action":"recall","project":"../private"}"#,
        r#"{"action":"remember","private":true,"text":"x","instance":"outside"}"#,
    ] {
        assert!(
            MemoryRequest::decode(PythonTextRef::from_scalar_text(raw)).is_err(),
            "{raw}"
        );
    }
}
#[test]
fn unconfirmed_or_malformed_journal_reply_is_not_a_save_receipt() {
    for raw in [
        "",
        "{}",
        r#"{"data":{"entryId":"not-confirmed"}}"#,
        r#"{"success":true}"#,
        r#"{"success":1,"data":{}}"#,
    ] {
        assert!(matches!(
            JournalSaveData::decode(raw, "", true),
            Err(JournalReplyError::Malformed)
        ));
    }
    assert_eq!(
        JournalSaveData::decode(
            r#"{"success":true,"data":{"entryId":"synthetic"}}"#,
            "",
            true
        )
        .unwrap()
        .as_json(),
        br#"{"entryId": "synthetic"}"#
    );
    assert!(JournalEntries::decode(r#"{"success":true,"data":{}}"#, "", true).is_err());
    let message = "x".repeat(600);
    let raw = serde_json::to_string(&json!({"success":false,"error":message})).unwrap();
    let Err(JournalReplyError::Refused(message)) = JournalSaveData::decode(&raw, "", false) else {
        panic!("refusal")
    };
    assert_eq!(message.codepoints().len(), 500);
}
#[test]
fn output_policy_preserves_every_pattern_without_accepting_a_new_editor() {
    assert!(OutputPolicy::decode(PythonTextRef::from_scalar_text(r#"{"anything":true}"#)).is_err());
    for raw in [
        r#"{"denied_patterns":null}"#,
        r#"{"denied_patterns":[""]}"#,
        r#"{"denied_patterns":[1]}"#,
    ] {
        assert!(OutputPolicy::decode(PythonTextRef::from_scalar_text(raw)).is_err());
    }
    let policy = OutputPolicy::decode(PythonTextRef::from_scalar_text(
        r#"{"denied_patterns":["(?=x)x","\\w+","\ud800"]}"#,
    ))
    .unwrap();
    assert_eq!(policy.patterns().len(), 3);
    assert_eq!(policy.patterns()[2].codepoints(), [0xd800]);
}
