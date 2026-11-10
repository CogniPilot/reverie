use super::*;
use serde_json::{Value as Json, json};
mod continuation;
mod employee_status;
mod principal;
const EID: &str = "11111111-2222-4333-8444-555555555555";
const RID: &str = "22222222-2222-4333-8444-555555555555";
const NONCE: &str = "33333333-2222-4333-8444-555555555555";
fn nonce() -> JournalId {
    JournalId::parse(NONCE).unwrap()
}
fn draft() -> Json {
    json!({"kind":"resource-operation","requestId":RID,"verb":"draft","employeeId":EID,"idempotencyKey":NONCE,"memoryMiB":49152})
}
fn claim() -> Json {
    json!({"kind":"resource-operation","requestId":RID,"verb":"claim","approval":{"employeeId":EID,"draftId":"44444444-2222-4333-8444-555555555555","operationId":"55555555-2222-4333-8444-555555555555","reservationId":"66666666-2222-4333-8444-555555555555","targetSid":"77777777-2222-4333-8444-555555555555","profileVersion":"1","profileDigest":"a".repeat(64),"previewDigest":"b".repeat(64),"ramPolicyDigest":"c".repeat(64)}})
}
fn human(value: &Json) -> HumanFrame {
    HumanFrame::decode(&serde_json::to_vec(value).unwrap()).unwrap()
}
fn request(value: &Json) -> ResourceOperationRequest {
    ResourceOperationRequest::decode(&human(value)).unwrap()
}
fn reply(value: &Json) -> Json {
    json!({"kind":"resource-owner-current","requestId":RID,"nonce":NONCE,"purpose":RAM_POOL_PURPOSE,"stage":if value["verb"]=="draft"{"preview"}else{"apply"},"owner":null,"ownerScopeDigest":"d".repeat(64),"expiresAtEpochMs":1800000000000u64,"approval":value.get("approval").cloned().unwrap_or(Json::Null),"principal":{"accountId":EID,"personId":"owner","sessionEpoch":0}})
}

#[test]
fn explicit_ram_hello_is_separate_from_unchanged_legacy_initial_hello() {
    assert!(decode_ram_pool_hello(br#"{"purpose":"resource-ram-pool-v2","version":2}"#).is_ok());
    for raw in [
        br#"{"purpose":"resource-replacement-v1","version":1}"#.as_slice(),
        br#"{"purpose":"resource-ram-pool-v2","version":1}"#,
        br#"{"purpose":"resource-ram-pool-v2","version":2.0}"#,
        br#"{"purpose":"resource-ram-pool-v2","version":2,"available":true}"#,
        br#"{"purpose":"resource-ram-pool-v2","version":1,"version":2}"#,
    ] {
        assert!(decode_ram_pool_hello(raw).is_err());
    }
    assert!(
        decode_initial_hello(br#"{"purpose":"resource-replacement-v1","version":true}"#).is_ok()
    );
    assert!(decode_initial_hello(br#"{"purpose":"resource-ram-pool-v2","version":2}"#).is_err());
}
#[test]
fn closed_preview_has_only_typed_original_employee_request_and_memory_data() {
    let value = draft();
    let actual = request(&value);
    assert_eq!(actual.request_id().as_str(), RID);
    assert_eq!(actual.employee_id().as_str(), EID);
    assert!(matches!(
        actual.selection(),
        ResourceRequestSelection::Preview {
            requested_memory_mib: 49152,
            ..
        }
    ));
    for (field, value) in [
        ("memoryMiB", json!(true)),
        ("memoryMiB", json!(512.0)),
        ("memoryMiB", json!(511)),
        ("memoryMiB", json!(1048577)),
        ("employeeId", json!("00000000-0000-0000-0000-000000000000")),
        ("available", json!(true)),
    ] {
        let mut changed = draft();
        changed[field] = value;
        assert!(ResourceOperationRequest::decode(&human(&changed)).is_err());
    }
    let challenge = actual.owner_challenge(&nonce()).unwrap();
    let wire: Json = serde_json::from_slice(&challenge.canonical().unwrap()).unwrap();
    assert_eq!(
        wire,
        json!({"kind":"resource-owner-check","requestId":RID,"nonce":NONCE,"stage":"preview","employeeId":EID,"approval":null})
    );
}
#[test]
fn ram_claim_requires_ninth_digest_and_owner_echo_of_every_original_approval_field() {
    let value = claim();
    let actual = request(&value);
    assert!(
        matches!(actual.selection(),ResourceRequestSelection::Apply{ram_policy_digest,..}if ram_policy_digest.as_str()=="c".repeat(64))
    );
    actual
        .require_profile_version(ProfileVersion::try_new(1).unwrap())
        .unwrap();
    let mut old = value.clone();
    old["approval"]
        .as_object_mut()
        .unwrap()
        .remove("ramPolicyDigest");
    assert!(ResourceOperationRequest::decode(&human(&old)).is_err());
    for field in [
        "employeeId",
        "draftId",
        "operationId",
        "reservationId",
        "targetSid",
        "profileVersion",
        "profileDigest",
        "previewDigest",
        "ramPolicyDigest",
    ] {
        let mut changed = reply(&value);
        changed["approval"][field] = if field.ends_with("Digest") {
            json!("e".repeat(64))
        } else if field == "profileVersion" {
            json!("2")
        } else {
            json!(NONCE)
        };
        assert!(
            actual
                .parse_owner_reply(&human(&changed), &nonce())
                .is_err(),
            "{field}"
        );
    }
    let challenge = actual.owner_challenge(&nonce()).unwrap();
    let wire: Json = serde_json::from_slice(&challenge.canonical().unwrap()).unwrap();
    assert_eq!(wire["approval"], value["approval"]);
}
#[test]
fn owner_reply_binds_request_nonce_purpose_stage_and_keeps_scope_expiry_as_data() {
    let value = claim();
    let actual = request(&value);
    let original = reply(&value);
    let owner = actual
        .parse_owner_reply(&human(&original), &nonce())
        .unwrap();
    assert_eq!(owner.owner(), &None);
    assert_eq!(owner.scope_digest().as_str(), "d".repeat(64));
    assert_eq!(owner.expires_at_epoch_ms(), 1800000000000);
    for (field, value) in [
        ("kind", json!("resource-result")),
        ("requestId", json!(NONCE)),
        ("nonce", json!(RID)),
        ("purpose", json!(PURPOSE)),
        ("stage", json!("preview")),
        ("ownerScopeDigest", json!("bad")),
        ("expiresAtEpochMs", json!(true)),
        ("expiresAtEpochMs", json!(1.0)),
        ("expiresAtEpochMs", json!(0)),
        ("owner", json!("x".repeat(201))),
        ("extra", json!(true)),
    ] {
        let mut changed = original.clone();
        changed[field] = value;
        assert!(
            actual
                .parse_owner_reply(&human(&changed), &nonce())
                .is_err()
        );
    }
    let mut changed = original.clone();
    changed["ownerScopeDigest"] = json!("e".repeat(64));
    assert_ne!(
        owner,
        actual
            .parse_owner_reply(&human(&changed), &nonce())
            .unwrap(),
        "the actual channel must pin the repeated signature"
    );
    changed["expiresAtEpochMs"] = json!(1);
    assert_eq!(
        actual
            .parse_owner_reply(&human(&changed), &nonce())
            .unwrap()
            .expires_at_epoch_ms(),
        1,
        "clock freshness remains the App owner's obligation"
    );
}
#[test]
fn version_int_conversion_never_replaces_the_original_draft_string_approval() {
    let expected = ProfileVersion::try_new(1).unwrap();
    for version in [
        json!("01"),
        json!(" +1 "),
        json!("١"),
        json!(true),
        json!(1),
        json!(1.75),
    ] {
        let mut value = claim();
        value["approval"]["profileVersion"] = version;
        let actual = request(&value);
        assert!(
            matches!(actual.selection(),ResourceRequestSelection::Apply{profile_version,..}if *profile_version==expected)
        );
        assert!(actual.require_profile_version(expected).is_err());
        assert!(
            actual
                .parse_owner_reply(&human(&reply(&value)), &nonce())
                .is_ok()
        );
    }
    for version in [
        json!(0),
        json!("-1"),
        json!("9007199254740992"),
        json!(null),
        json!("1.0"),
    ] {
        let mut value = claim();
        value["approval"]["profileVersion"] = version;
        assert!(ResourceOperationRequest::decode(&human(&value)).is_err());
    }
}
#[test]
fn current_metadata_owner_is_unique_and_distinguishes_null_from_lossless_text() {
    let eid = ProfileEmployeeId::parse(EID).unwrap();
    let metadata = |raw: &[u8]| crate::storage_identity::decode_metadata(raw).unwrap();
    let raw = format!(
        r#"{{"employees":[{{"id":"{EID}"}}],"retired":[{{"id":"{EID}","owner":"retired"}}]}}"#
    );
    metadata(raw.as_bytes())
        .require_resource_owner(&eid, &None)
        .unwrap();
    assert!(
        metadata(raw.as_bytes())
            .require_resource_owner(&eid, &Some(PythonText::from_scalar_text("")))
            .is_err()
    );
    let raw = format!(r#"{{"employees":[{{"id":"{EID}","owner":"\ud800"}}]}}"#);
    metadata(raw.as_bytes())
        .require_resource_owner(&eid, &Some(PythonText::try_new(vec![0xd800]).unwrap()))
        .unwrap();
    for raw in [
        format!(r#"{{"employees":[],"retired":[{{"id":"{EID}"}}]}}"#),
        format!(r#"{{"employees":[{{"id":"{EID}"}},{{"id":"{EID}"}}]}}"#),
    ] {
        assert!(
            metadata(raw.as_bytes())
                .require_resource_owner(&eid, &None)
                .is_err()
        );
    }
}
