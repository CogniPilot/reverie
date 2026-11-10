//! The GPU queue request carries the exact typed intent in the owner echo.
use super::*;
const SID: &str = "77777777-2222-4333-8444-555555555555";
const DEVICE: &str = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

fn gpu_request() -> Json {
    json!({"kind":"resource-operation","requestId":RID,"verb":"gpu-request","employeeId":EID,
        "approval":{"expected":{"sessionId":SID,"sessionGeneration":2,"bindingDigest":"b".repeat(64),"revision":1},
        "enabled":true,"deviceUuid":DEVICE}})
}
#[test]
fn gpu_request_reuses_closed_intent_and_exact_challenge_echo() {
    let value = gpu_request();
    let actual = request(&value);
    assert!(
        matches!(actual.selection(), ResourceRequestSelection::GpuRequest { employee_id, intent }
        if employee_id.as_str() == EID && intent.expected().session().as_str() == SID)
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
        "stage":"gpu-request","employeeId":EID,"approval":value["approval"]})
    );
    let mut echo = reply(&value);
    echo["stage"] = json!("gpu-request");
    assert!(actual.parse_owner_reply(&human(&echo), &nonce()).is_ok());
    for revision in [json!(true), json!(1.0), json!(2)] {
        let mut changed = echo.clone();
        changed["approval"]["expected"]["revision"] = revision;
        assert!(
            actual
                .parse_owner_reply(&human(&changed), &nonce())
                .is_err()
        );
    }
    echo["stage"] = json!("apply");
    assert!(actual.parse_owner_reply(&human(&echo), &nonce()).is_err());
}
#[test]
fn gpu_selection_rejects_extra_targets_and_invalid_device_requests() {
    let status = json!({"kind":"resource-operation","requestId":RID,"verb":"gpu-status","employeeId":EID,"sessionId":SID});
    assert!(
        matches!(request(&status).selection(), ResourceRequestSelection::GpuStatus { session_id, .. }
        if session_id.as_str() == SID)
    );
    let mut changed = status;
    changed["approval"] = gpu_request()["approval"].clone();
    assert!(ResourceOperationRequest::decode(&human(&changed)).is_err());
    for (key, data) in [
        ("deviceUuid", json!("all")),
        ("enabled", json!(false)),
        ("socket", json!("/outside")),
    ] {
        let mut changed = gpu_request();
        changed["approval"][key] = data;
        assert!(ResourceOperationRequest::decode(&human(&changed)).is_err());
    }
}
