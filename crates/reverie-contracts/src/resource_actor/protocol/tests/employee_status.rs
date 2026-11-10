//! Closed request/nonce controls only; these do not forge native observations.
use super::*;
const SID: &str = "77777777-2222-4333-8444-555555555555";
fn status() -> Json {
    json!({"kind":"resource-operation","requestId":RID,"verb":"employee-status","employeeId":EID,"sessionId":SID})
}
#[test]
fn employee_status_is_readonly_preview_authority_with_exact_employee_session() {
    let actual = request(&status());
    assert!(
        matches!(actual.selection(), ResourceRequestSelection::EmployeeStatus { employee_id, session_id }
        if employee_id.as_str() == EID && session_id.as_str() == SID)
    );
    let challenge: Json = serde_json::from_slice(
        &actual
            .owner_challenge(&nonce())
            .unwrap()
            .canonical()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        challenge,
        json!({"kind":"resource-owner-check","requestId":RID,"nonce":NONCE,
        "stage":"status","employeeId":EID,"approval":null})
    );
    for (key, value) in [
        ("sessionId", json!(true)),
        ("sessionId", json!("AAAAAAAA-2222-4333-8444-555555555555")),
        ("memoryMiB", json!(8192)),
        ("cpuWeight", json!(100)),
        ("consent", json!(true)),
        ("verb", json!("employee-write")),
    ] {
        let mut changed = status();
        changed[key] = value;
        assert!(ResourceOperationRequest::decode(&human(&changed)).is_err());
    }
}
