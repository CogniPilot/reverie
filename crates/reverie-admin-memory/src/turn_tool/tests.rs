use super::*;

fn invoke_line(line: &str, calls: usize, help_shown: bool) -> Value {
    let request = json!({
        "phase": "invoke", "name": "journal", "read_only": false,
        "state": {"calls": calls, "help_shown": help_shown},
        "arguments": json!({"command": line}).to_string(),
    });
    let response = execute(request.to_string().as_bytes()).unwrap();
    serde_json::from_str(response.get()).unwrap()
}

#[test]
fn grants_first_help_and_stops_after_three_charged_calls() {
    let help = invoke_line("help", 0, false);
    assert_eq!(help["state"], json!({"calls": 0, "help_shown": true}));
    assert_eq!(help["reply"]["status"], "ok");
    let again = invoke_line("help recall", 0, true);
    assert_eq!(again["state"]["calls"], 1);
    let invalid = invoke_line("not-a-command", 1, true);
    assert_eq!(invalid["state"]["calls"], 2);
    assert_eq!(invalid["reply"]["status"], "refused");
    let read = invoke_line("recall recent results", 2, true);
    assert_eq!(read["state"]["calls"], 3);
    assert_eq!(read["dispatch"]["arguments"]["query"], "recent results");
    let exhausted = invoke_line("help", 3, true);
    assert_eq!(exhausted["reply"]["reason"], "turn_budget");
    assert_eq!(exhausted["replay"], "{}");
}

#[test]
fn read_only_advertisement_keeps_save_recognizable_for_refusal() {
    let advertised = toolset(true, false);
    assert!(!advertised.offered.contains(&"journal_commit"));
    assert!(advertised.accepted_calls.contains(&"journal_commit"));
    assert_eq!(advertised.call_limit, 3);
    assert!(help::text("SAVE", true).unwrap().contains("read-only"));
}

#[test]
fn merges_legacy_recall_by_character_count() {
    let exact = merge("雪雪".into(), String::new(), "", 2).unwrap();
    assert_eq!(exact.status, Some("included"));
    assert_eq!(exact.text, "雪雪");
    let small = merge("雪雪".into(), "旧".into(), "", 1).unwrap();
    assert_eq!(small.status, Some("omitted_due_to_budget"));
    assert_eq!(small.text, "旧");
    assert!(small.context_note.is_some());
    let partial = merge("雪雪".into(), "旧".into(), "", 2).unwrap();
    assert_eq!(partial.status, Some("included_other_evidence_omitted"));
    assert_eq!(partial.text, "雪雪");
    assert!(merge("".into(), "旧".into(), "", 0).is_err());
}
