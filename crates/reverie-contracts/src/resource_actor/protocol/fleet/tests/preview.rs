use super::*;

fn request_value() -> Json {
    let mut value = request();
    for name in ["consent", "approval", "verb"] {
        value.as_object_mut().unwrap().remove(name);
    }
    value["kind"] = json!("fleet-preview");
    value
}
fn selected(value: &Json) -> Result<FleetPreviewRequest> {
    FleetPreviewRequest::decode(&human(value))
}
fn current_value() -> Json {
    let mut value = owner_reply();
    for name in ["consent", "approval"] {
        value.as_object_mut().unwrap().remove(name);
    }
    value["kind"] = json!("fleet-preview-owner-current");
    value
}

#[test]
fn preview_accepts_no_frontend_policy_or_approval() {
    let original = selected(&request_value()).unwrap();
    assert_eq!(original.request_id().as_str(), REQUEST);
    for (name, replacement) in [
        ("policy", json!({})),
        ("approval", request()["approval"].clone()),
        ("consent", json!(true)),
        ("employeeId", json!(OPERATION)),
        ("version", json!(1.0)),
        ("purpose", json!(RAM_POOL_PURPOSE)),
        ("requestId", json!("00000000-0000-0000-0000-000000000000")),
    ] {
        let mut value = request_value();
        value[name] = replacement;
        assert!(selected(&value).is_err(), "{name}");
    }
    let mut missing = request_value();
    missing.as_object_mut().unwrap().remove("principal");
    assert!(selected(&missing).is_err());
    assert!(decode(&request_value()).is_err());
}

#[test]
fn preview_viewer_echo_binds_original_request_principal_and_fresh_nonce() {
    let original = selected(&request_value()).unwrap();
    let nonce = JournalId::parse(NONCE).unwrap();
    let challenge = original.owner_challenge(&nonce).unwrap();
    let challenge: Json = serde_json::from_slice(&challenge.canonical().unwrap()).unwrap();
    assert_eq!(challenge["kind"], "fleet-preview-owner-check");
    assert_eq!(challenge["principal"], request_value()["principal"]);
    assert_eq!(challenge["requestId"], REQUEST);
    assert_eq!(challenge["nonce"], NONCE);
    let current = original
        .parse_owner_reply(&human(&current_value()), &nonce)
        .unwrap();
    assert_eq!(current.principal(), original.principal());
    assert_eq!(current.scope_digest().as_str(), "e".repeat(64));
    for (name, replacement) in [
        ("kind", json!("fleet-maintenance-owner-current")),
        ("nonce", json!(NEXT)),
        ("requestId", json!(NEXT)),
        (
            "principal",
            json!({"accountId":NEXT,"personId":"owner","sessionEpoch":3}),
        ),
        ("ownerScopeDigest", json!("E".repeat(64))),
        ("expiresAtEpochMs", json!(0)),
        ("expiresAtEpochMs", json!(1.0)),
        ("consent", json!(true)),
    ] {
        let mut value = current_value();
        value[name] = replacement;
        assert!(
            original.parse_owner_reply(&human(&value), &nonce).is_err(),
            "{name}"
        );
    }
}

#[test]
fn observed_reply_remains_explicitly_unqualified_and_does_not_rederive_selection() {
    let original = selected(&request_value()).unwrap();
    let approval = decode(&request()).unwrap();
    let policy = crate::worker_pool::tests::policy();
    let expiry = 1_800_000_000_000_u64;
    let reply = original
        .observed_reply(approval.selection(), &policy, expiry)
        .unwrap();
    let reply: Json = serde_json::from_slice(&reply.canonical().unwrap()).unwrap();
    assert_eq!(reply["approval"], request()["approval"]);
    assert_eq!(reply["policy"], serde_json::to_value(&policy).unwrap());
    assert_eq!(reply["requestId"], REQUEST);
    assert_eq!(reply["status"], "target-verification-required");
    assert_eq!(reply["expiresAtEpochMs"], expiry);
    assert_eq!(reply.as_object().unwrap().len(), 8);
    for expires in [0, reverie_core::revision::JS_SAFE_MAX + 1] {
        assert!(
            original
                .observed_reply(approval.selection(), &policy, expires)
                .is_err()
        );
    }
    let mut invalid = policy;
    invalid.memory_max_mi_b = 1;
    assert!(
        original
            .observed_reply(approval.selection(), &invalid, expiry)
            .is_err()
    );
}

#[test]
fn qualified_reply_only_requests_separate_maintenance_consent() {
    let original = selected(&request_value()).unwrap();
    let approval = decode(&request()).unwrap();
    let policy = crate::worker_pool::tests::policy();
    let expiry = 1_800_000_000_000_u64;
    let ordinary = original
        .observed_reply(approval.selection(), &policy, expiry)
        .unwrap();
    let ordinary: Json = serde_json::from_slice(&ordinary.canonical().unwrap()).unwrap();
    let reply = original
        .qualified_reply(approval.selection(), &policy, expiry)
        .unwrap();
    let reply: Json = serde_json::from_slice(&reply.canonical().unwrap()).unwrap();
    let mut expected = ordinary;
    expected["status"] = json!("awaiting-maintenance-consent");
    assert_eq!(reply, expected);
    assert!(
        decode(&reply).is_err(),
        "a preview reply is never a consent request"
    );
    for expires in [0, reverie_core::revision::JS_SAFE_MAX + 1] {
        assert!(
            original
                .qualified_reply(approval.selection(), &policy, expires)
                .is_err()
        );
    }
    let mut invalid = policy;
    invalid.memory_max_mi_b = 1;
    assert!(
        original
            .qualified_reply(approval.selection(), &invalid, expiry)
            .is_err()
    );
}
