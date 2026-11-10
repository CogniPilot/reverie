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

#[test]
fn employee_policy_edit_requires_exact_typed_owner_approval() {
    let value = json!({
        "kind":"resource-operation","requestId":RID,"verb":"employee-policy-edit","employeeId":EID,
        "approval":{"sessionId":SID,"operationId":NONCE,"expectedRevision":"a".repeat(64),
            "memoryHighMiB":8192,"cpuWeight":100}
    });
    let actual = request(&value);
    assert!(matches!(actual.selection(),
        ResourceRequestSelection::EmployeePolicyEdit { employee_id, approval }
        if employee_id.as_str() == EID && approval.session().as_str() == SID
           && approval.requested().memory_high_mib() == 8192
    ));
    let mut owner = reply(&value);
    owner["stage"] = json!("employee-policy-edit");
    assert!(actual.parse_owner_reply(&human(&owner), &nonce()).is_ok());
    for (name, changed) in [
        ("sessionId", json!(RID)),
        ("operationId", json!(RID)),
        ("expectedRevision", json!("b".repeat(64))),
        ("memoryHighMiB", json!(8193)),
        ("cpuWeight", json!(100.0)),
        ("extra", json!(true)),
    ] {
        let mut changed_owner = owner.clone();
        changed_owner["approval"][name] = changed;
        assert!(
            actual
                .parse_owner_reply(&human(&changed_owner), &nonce())
                .is_err()
        );
    }
    for (name, changed) in [
        ("memoryHighMiB", json!(49153)),
        ("cpuWeight", json!(0)),
        ("cpuWeight", json!(true)),
        ("expectedRevision", json!("A".repeat(64))),
    ] {
        let mut changed_request = value.clone();
        changed_request["approval"][name] = changed;
        assert!(ResourceOperationRequest::decode(&human(&changed_request)).is_err());
    }
}
