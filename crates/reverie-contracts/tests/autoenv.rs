use reverie_contracts::autoenv::AutoenvApproval;
use reverie_core::PythonText;
use serde_json::{Value, json};
fn text(value: &Value) -> PythonText {
    PythonText::try_new(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|point| u32::try_from(point.as_u64().unwrap()).unwrap())
            .collect(),
    )
    .unwrap()
}
#[test]
fn actual_original_approval_rule_outputs_keep_whitespace_first_match_and_error_order() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/autoenv-approval-python.json")).unwrap();
    let rows = corpus["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 80);
    for row in rows {
        assert_eq!(selected(row), row["expected"], "{row}");
    }
}
fn selected(row: &Value) -> Value {
    let repository = text(&row["repository"]);
    for line in row["lines"].as_array().unwrap() {
        let line = text(line);
        match AutoenvApproval::from_line(line.as_text_ref(), repository.as_text_ref()) {
            Ok(None) => continue,
            Err(_) => return json!({"error":"matchedRule"}),
            Ok(Some(approval)) => return approval_data(approval),
        }
    }
    json!({"selected":false})
}
fn approval_data(approval: AutoenvApproval) -> Value {
    for command in approval.commands() {
        assert!(approval.allows_command(command.as_text_ref()));
    }
    assert!(
        !approval
            .allows_command(PythonText::from_scalar_text("never-approved-command").as_text_ref())
    );
    let commands = approval
        .commands()
        .iter()
        .map(|cmd| cmd.codepoints())
        .collect::<Vec<_>>();
    json!({"selected":true,"attribute":approval.attribute().codepoints(),"commands":commands})
}
