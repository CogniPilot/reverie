use super::*;
use reverie_core::ids::NativeOperationId;
const NEXT: &str = "88888888-2222-4333-8444-555555555555";
const REF: &str = "99999999-2222-4333-8444-555555555555";
fn continued(verb: &str) -> Json {
    json!({"kind":"resource-operation","requestId":NEXT,"verb":verb,"reference":REF})
}
fn continuation(value: &Json) -> ResourceContinuationRequest {
    ResourceContinuationRequest::decode(&human(value)).unwrap()
}
fn launch(value: &Json) -> (crate::worker_launch::WorkerRequest, JournalDigest) {
    let config = crate::worker_config::decode(
        br#"{"mounts":[{"source":"/owned","destination":"/project","readOnly":false}]}"#,
    )
    .unwrap();
    let bytes = serde_json::to_vec(value).unwrap();
    let parsed = crate::legacy_json::decode_utf8(&bytes).unwrap();
    let digest: [u8; 32] = crate::reservation_control::fingerprint(&parsed).unwrap();
    (
        crate::worker_launch::WorkerRequest::decode(&bytes, &config).unwrap(),
        JournalDigest::parse(&crate::digest::hex(&digest)).unwrap(),
    )
}
fn launch_value() -> Json {
    json!({"sessionId":"77777777-2222-4333-8444-555555555555","cwd":"/project","command":"echo é😀","env":{"TERM":"xterm"},"cols":80,"rows":24,"attachOnly":false})
}
fn selected(original: &ResourceOperationRequest, value: &Json) -> RamLaunchCommandData {
    let (worker, digest) = launch(value);
    RamLaunchCommandData::from_observed_data(
        original,
        &NativeOperationId::parse(REF).unwrap(),
        &worker,
        &digest,
    )
    .unwrap()
}
fn command_reply(original: &Json, check: &HumanFrame) -> Json {
    let mut value = reply(original);
    let check: Json = serde_json::from_slice(&check.canonical().unwrap()).unwrap();
    value["kind"] = json!("resource-command-current");
    for name in [
        "requestId",
        "nonce",
        "employeeId",
        "reference",
        "sessionId",
        "cwd",
        "commandDigest",
        "requestDigest",
    ] {
        value[name] = check[name].clone();
    }
    value
}
#[test]
fn closed_continuations_require_actual_reference_and_fresh_request_id_data() {
    let original = request(&claim());
    for verb in ["publication", "prepare", "source-stop", "start"] {
        let value = continued(verb);
        continuation(&value)
            .require_original(&original, &NativeOperationId::parse(REF).unwrap())
            .unwrap();
    }
    for verb in [
        "draft",
        "claim",
        "verify",
        "finalize",
        "completion",
        "unknown",
    ] {
        assert!(ResourceContinuationRequest::decode(&human(&continued(verb))).is_err());
    }
    let mut extra = continued("start");
    extra["approval"] = claim()["approval"].clone();
    assert!(ResourceContinuationRequest::decode(&human(&extra)).is_err());
    let mut replay = continued("start");
    replay["requestId"] = json!(RID);
    assert!(
        continuation(&replay)
            .require_original(&original, &NativeOperationId::parse(REF).unwrap())
            .is_err()
    );
    assert!(
        continuation(&continued("start"))
            .require_original(&original, &NativeOperationId::parse(EID).unwrap())
            .is_err()
    );
}
#[test]
fn continuation_owner_echo_keeps_original_nine_and_principal_with_new_request_id() {
    let value = claim();
    let original = request(&value);
    let next = continuation(&continued("prepare"));
    let check = original
        .continuation_owner_challenge(&next, &nonce())
        .unwrap();
    let check: Json = serde_json::from_slice(&check.canonical().unwrap()).unwrap();
    assert_eq!(check["requestId"], NEXT);
    assert_eq!(check["approval"], value["approval"]);
    let mut current = reply(&value);
    current["requestId"] = json!(NEXT);
    original
        .parse_continuation_owner_reply(&human(&current), &next, &nonce())
        .unwrap();
    current["approval"]["ramPolicyDigest"] = json!("e".repeat(64));
    assert!(
        original
            .parse_continuation_owner_reply(&human(&current), &next, &nonce())
            .is_err()
    );
}
#[test]
fn actual_typed_launch_uses_js_tuple_golden_and_refuses_target_or_attach_substitution() {
    let original = request(&claim());
    let value = launch_value();
    let data = selected(&original, &value);
    // Captured Node22 JSON.stringify([SID,cwd,command]) SHA256, Unicode included.
    assert_eq!(
        data.command_digest().as_str(),
        "df4328298d284d6d5b4a929a125b60855f6ca9e1f6bc3c2509b8554275859a75"
    );
    let mut attached = value.clone();
    attached["attachOnly"] = json!(true);
    let (worker, digest) = launch(&attached);
    assert!(
        RamLaunchCommandData::from_observed_data(
            &original,
            &NativeOperationId::parse(REF).unwrap(),
            &worker,
            &digest
        )
        .is_err()
    );
    let mut foreign = value;
    foreign["sessionId"] = json!(EID);
    let (worker, digest) = launch(&foreign);
    assert!(
        RamLaunchCommandData::from_observed_data(
            &original,
            &NativeOperationId::parse(REF).unwrap(),
            &worker,
            &digest
        )
        .is_err()
    );
}
#[test]
fn command_reply_exactly_echoes_original_selection_nonce_and_held_request_fingerprint() {
    let value = claim();
    let original = request(&value);
    let next = continuation(&continued("start"));
    let data = selected(&original, &launch_value());
    let check = original.command_challenge(&next, &data, &nonce()).unwrap();
    let valid = command_reply(&value, &check);
    original
        .parse_command_reply(&human(&valid), &next, &data, &nonce())
        .unwrap();
    for name in [
        "requestId",
        "nonce",
        "employeeId",
        "reference",
        "sessionId",
        "commandDigest",
        "requestDigest",
    ] {
        let mut changed = valid.clone();
        changed[name] = json!(if name.ends_with("Digest") {
            "f".repeat(64)
        } else {
            RID.to_owned()
        });
        assert!(
            original
                .parse_command_reply(&human(&changed), &next, &data, &nonce())
                .is_err(),
            "{name}"
        );
    }
    let mut changed = valid.clone();
    changed["cwd"] = json!("/project/other");
    assert!(
        original
            .parse_command_reply(&human(&changed), &next, &data, &nonce())
            .is_err()
    );
    let mut changed = valid.clone();
    changed["approval"]["ramPolicyDigest"] = json!("f".repeat(64));
    assert!(
        original
            .parse_command_reply(&human(&changed), &next, &data, &nonce())
            .is_err()
    );
    let mut changed = valid;
    changed.as_object_mut().unwrap().remove("principal");
    assert!(
        original
            .parse_command_reply(&human(&changed), &next, &data, &nonce())
            .is_err()
    );
}
#[test]
fn full_request_fingerprint_separately_binds_environment_and_terminal_data() {
    let original = request(&claim());
    let next = continuation(&continued("start"));
    let value = launch_value();
    let first = selected(&original, &value);
    let mut changed = value;
    changed["env"]["TERM"] = json!("vt100");
    changed["cols"] = json!(120);
    let second = selected(&original, &changed);
    assert_eq!(first.command_digest(), second.command_digest());
    assert_ne!(first.request_digest(), second.request_digest());
    let check = original.command_challenge(&next, &first, &nonce()).unwrap();
    let current = command_reply(&claim(), &check);
    assert!(
        original
            .parse_command_reply(&human(&current), &next, &second, &nonce())
            .is_err()
    );
}
#[test]
fn command_owner_incarnation_equality_and_expiry_remain_data_not_permission() {
    let value = claim();
    let original = request(&value);
    let next = continuation(&continued("start"));
    let data = selected(&original, &launch_value());
    let check = original.command_challenge(&next, &data, &nonce()).unwrap();
    let first = command_reply(&value, &check);
    let owner = original
        .parse_command_reply(&human(&first), &next, &data, &nonce())
        .unwrap();
    let mut changed = first.clone();
    changed["principal"]["sessionEpoch"] = json!(1);
    assert_ne!(
        owner,
        original
            .parse_command_reply(&human(&changed), &next, &data, &nonce())
            .unwrap()
    );
    let mut expired = first;
    expired["expiresAtEpochMs"] = json!(1);
    assert_eq!(
        original
            .parse_command_reply(&human(&expired), &next, &data, &nonce())
            .unwrap()
            .expires_at_epoch_ms(),
        1,
        "clock/authority verification belongs to actual retained App owner"
    );
}
