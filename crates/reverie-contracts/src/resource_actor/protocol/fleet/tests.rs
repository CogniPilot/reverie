use super::*;
use serde_json::{Value as Json, json};
mod preview;

const REQUEST: &str = "10000000-0000-4000-8000-000000000001";
const OPERATION: &str = "10000000-0000-4000-8000-000000000002";
const PREVIEW: &str = "10000000-0000-4000-8000-000000000003";
const NONCE: &str = "10000000-0000-4000-8000-000000000004";
const NEXT: &str = "10000000-0000-4000-8000-000000000005";
fn request() -> Json {
    json!({"kind":"fleet-maintenance","purpose":FLEET_MAINTENANCE_PURPOSE,
        "version":1,"verb":"drain","requestId":REQUEST,"consent":true,
        "approval":{"operationId":OPERATION,"previewId":PREVIEW,
            "cohortDigest":"a".repeat(64),"poolPolicyDigest":"b".repeat(64),
            "coverageDigest":"c".repeat(64),"revisionDigest":"d".repeat(64)},
        "principal":{"accountId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "personId":"owner","sessionEpoch":3}})
}
fn decode(value: &Json) -> Result<FleetMaintenanceRequest> {
    FleetMaintenanceRequest::decode(
        &HumanFrame::decode(&serde_json::to_vec(value).unwrap()).map_err(frame_error)?,
    )
}
#[test]
fn accepts_only_distinct_explicit_fleet_approval_data() {
    let hello =
        serde_json::to_vec(&json!({"purpose":FLEET_MAINTENANCE_PURPOSE,"version":1})).unwrap();
    assert!(decode_fleet_maintenance_hello(&hello).is_ok());
    assert!(decode(&request()).is_ok());
}
#[test]
fn per_employee_and_installation_consent_cannot_substitute_for_fleet() {
    for purpose in [
        RAM_POOL_PURPOSE,
        POOL_INSTALLATION_CONSENT_PURPOSE,
        POOL_REGISTRATION_PURPOSE,
    ] {
        let mut selected = request();
        selected["purpose"] = json!(purpose);
        assert!(decode(&selected).is_err());
        let hello = serde_json::to_vec(&json!({"purpose":purpose,"version":1})).unwrap();
        assert!(decode_fleet_maintenance_hello(&hello).is_err());
    }
}
#[test]
fn refuses_implicit_or_open_ended_approval() {
    for (field, value) in [
        ("consent", json!(false)),
        ("consent", json!(1)),
        ("consent", json!("true")),
        ("version", json!(true)),
        ("version", json!(1.0)),
        ("version", json!("1")),
        ("verb", json!("stop-laptops")),
        ("granted", json!(true)),
    ] {
        let mut selected = request();
        selected[field] = value;
        assert!(decode(&selected).is_err(), "{field}");
    }
    for field in ["consent", "principal", "approval", "purpose", "version"] {
        let mut selected = request();
        selected.as_object_mut().unwrap().remove(field);
        assert!(decode(&selected).is_err(), "missing {field}");
    }
}
fn human(value: &Json) -> HumanFrame {
    HumanFrame::decode(&serde_json::to_vec(value).unwrap()).unwrap()
}
fn owner_reply() -> Json {
    let selected = request();
    json!({"kind":"fleet-maintenance-owner-current","purpose":FLEET_MAINTENANCE_PURPOSE,
        "version":1,"requestId":REQUEST,"nonce":NONCE,"consent":true,
        "approval":selected["approval"],"principal":selected["principal"],
        "ownerScopeDigest":"e".repeat(64),"expiresAtEpochMs":1_800_000_000_000_u64})
}
#[test]
fn fresh_challenge_binds_whole_original_approval_and_principal() {
    let selected = decode(&request()).unwrap();
    let nonce = JournalId::parse(NONCE).unwrap();
    let challenge = selected.owner_challenge(&nonce).unwrap();
    let value: Json = serde_json::from_slice(&challenge.canonical().unwrap()).unwrap();
    assert_eq!(
        value,
        json!({"kind":"fleet-maintenance-owner-check",
        "purpose":FLEET_MAINTENANCE_PURPOSE,"version":1,"requestId":REQUEST,
        "nonce":NONCE,"approval":request()["approval"],"principal":request()["principal"]})
    );
    let original = selected
        .parse_owner_reply(&human(&owner_reply()), &nonce)
        .unwrap();
    assert_eq!(original.principal(), selected.principal());
    assert_eq!(original.scope_digest().as_str(), "e".repeat(64));
    assert_eq!(original.expires_at_epoch_ms(), 1_800_000_000_000_u64);
    assert_eq!(selected.selection().operation_id().as_str(), OPERATION);
    let next = JournalId::parse(NEXT).unwrap();
    assert!(
        selected
            .parse_owner_reply(&human(&owner_reply()), &next)
            .is_err()
    );
    let mut reply = owner_reply();
    reply["nonce"] = json!(NEXT);
    assert_eq!(
        original,
        selected.parse_owner_reply(&human(&reply), &next).unwrap()
    );
}
#[test]
fn every_approval_and_current_owner_field_is_bound() {
    let selected = decode(&request()).unwrap();
    let nonce = JournalId::parse(NONCE).unwrap();
    for name in [
        "operationId",
        "previewId",
        "cohortDigest",
        "poolPolicyDigest",
        "coverageDigest",
        "revisionDigest",
    ] {
        let mut reply = owner_reply();
        reply["approval"][name] = if name.ends_with("Id") {
            json!(NEXT)
        } else {
            json!("f".repeat(64))
        };
        assert!(
            selected.parse_owner_reply(&human(&reply), &nonce).is_err(),
            "{name}"
        );
    }
    for (name, bad) in [
        ("requestId", json!(NEXT)),
        ("nonce", json!(NEXT)),
        ("purpose", json!(RAM_POOL_PURPOSE)),
        ("consent", json!(false)),
        ("expiresAtEpochMs", json!(0)),
        ("expiresAtEpochMs", json!(true)),
        ("ownerScopeDigest", json!("E".repeat(64))),
        ("owner", json!("owner")),
    ] {
        let mut reply = owner_reply();
        reply[name] = bad;
        assert!(
            selected.parse_owner_reply(&human(&reply), &nonce).is_err(),
            "{name}"
        );
    }
    for (name, bad) in [
        ("accountId", json!(NEXT)),
        ("personId", json!(NEXT)),
        ("sessionEpoch", json!(4)),
    ] {
        let mut reply = owner_reply();
        reply["principal"][name] = bad;
        assert!(
            selected.parse_owner_reply(&human(&reply), &nonce).is_err(),
            "{name}"
        );
    }
}
#[test]
fn malformed_nested_identifiers_and_duplicate_frames_are_rejected() {
    for (name, bad) in [
        ("operationId", json!("00000000-0000-0000-0000-000000000000")),
        ("previewId", json!("not-an-id")),
        ("cohortDigest", json!("A".repeat(64))),
        ("poolPolicyDigest", json!("b".repeat(63))),
        ("coverageDigest", json!(true)),
        ("revisionDigest", json!("d".repeat(65))),
        ("hostCommand", json!("stop")),
    ] {
        let mut selected = request();
        selected["approval"][name] = bad;
        assert!(decode(&selected).is_err(), "{name}");
    }
    let raw = serde_json::to_string(&request()).unwrap();
    let duplicate = raw.replacen('{', "{\"consent\":true,", 1);
    assert!(HumanFrame::decode(duplicate.as_bytes()).is_err());
}
