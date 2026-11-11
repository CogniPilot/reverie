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

#[test]
fn gpu_apply_echo_selects_exact_saved_request_and_cannot_answer_queue_challenge() {
    let data = json!({"kind":"resource-operation","requestId":RID,"verb":"gpu-apply","employeeId":EID,
        "approval":{"sessionId":SID,"sessionGeneration":2,"bindingDigest":"b".repeat(64),
        "revision":9_007_199_254_740_991_u64,"deviceUuid":DEVICE}});
    let selected = request(&data);
    assert!(
        matches!(selected.selection(), ResourceRequestSelection::GpuApply { queued, .. }
        if queued.session().as_str() == SID && queued.device().unwrap().as_str() == DEVICE)
    );
    let mut echo = reply(&data);
    echo["stage"] = json!("gpu-apply");
    assert!(selected.parse_owner_reply(&human(&echo), &nonce()).is_ok());
    echo["approval"]["deviceUuid"] = Json::Null;
    assert!(selected.parse_owner_reply(&human(&echo), &nonce()).is_err());
    echo["approval"] = data["approval"].clone();
    echo["stage"] = json!("gpu-request");
    assert!(selected.parse_owner_reply(&human(&echo), &nonce()).is_err());
    let mut unsafe_data = data;
    unsafe_data["approval"]["start"] = json!(true);
    assert!(ResourceOperationRequest::decode(&human(&unsafe_data)).is_err());
}

#[test]
fn readiness_is_a_separate_owner_stage_and_preserves_exact_legacy_status_and_queue_replies() {
    use reverie_core::{
        gpu_access::{
            GpuActiveData, GpuApplied, GpuBinding, GpuChoicesData, GpuDeviceUuid, GpuStatusData,
        },
        revision::Generation,
    };
    let employee = ProfileEmployeeId::parse(EID).unwrap();
    let session = ProfileSessionId::parse(SID).unwrap();
    let generation = Generation::try_new(2).unwrap();
    let digest = JournalDigest::parse(&"b".repeat(64)).unwrap();
    let policies =
        crate::device_policy::gpu::validate_config(&crate::worker_config::decode(b"{}").unwrap())
            .unwrap();
    let applied = GpuApplied::project(&policies, &session, &employee);
    let status = GpuStatusData::new(
        JournalId::parse(EID).unwrap(),
        GpuBinding::new(session, generation, digest.clone()),
        Some(
            GpuQueuedRequest::try_new(
                2,
                JournalId::parse(SID).unwrap(),
                generation,
                digest,
                Some(GpuDeviceUuid::parse(DEVICE).unwrap()),
            )
            .unwrap(),
        ),
        GpuChoicesData::unknown(),
        applied,
        GpuActiveData::Stopped,
    )
    .unwrap();
    let baseline: Json =
        serde_json::from_slice(&crate::gpu_access::encode_status(&status)).unwrap();
    let mut read = json!({"kind":"resource-operation","requestId":RID,"verb":"gpu-status","employeeId":EID,"sessionId":SID});
    for command in [&read, &gpu_request()] {
        let native: Json = serde_json::from_slice(
            &request(command)
                .gpu_result_reply(&status, true)
                .unwrap()
                .canonical()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            native,
            json!({"kind":"resource-result","requestId":RID,"value":baseline})
        );
    }
    read["verb"] = json!("gpu-apply-status");
    let readiness = request(&read);
    assert!(matches!(
        readiness.selection(),
        ResourceRequestSelection::GpuApplyStatus { .. }
    ));
    let mut echo = reply(&read);
    echo["stage"] = json!("gpu-status");
    assert!(
        readiness
            .parse_owner_reply(&human(&echo), &nonce())
            .is_err()
    );
    echo["stage"] = json!("gpu-apply-status");
    assert!(readiness.parse_owner_reply(&human(&echo), &nonce()).is_ok());
    let native: Json = serde_json::from_slice(
        &readiness
            .gpu_result_reply(&status, true)
            .unwrap()
            .canonical()
            .unwrap(),
    )
    .unwrap();
    let mut observed = baseline;
    observed["canApply"] = json!(true);
    assert_eq!(
        native,
        json!({"kind":"resource-result","requestId":RID,"value":observed})
    );
}
