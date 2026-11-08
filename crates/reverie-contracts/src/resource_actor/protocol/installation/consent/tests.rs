use super::*;
use serde_json::{Value as Json, json};

const REQUEST: &str = "10000000-0000-4000-8000-000000000001";
const OFFER: &str = "10000000-0000-4000-8000-000000000002";
const NONCE: &str = "10000000-0000-4000-8000-000000000003";
const OTHER: &str = "10000000-0000-4000-8000-000000000004";
fn request() -> Json {
    json!({"kind":"pool-installation-consent","purpose":POOL_INSTALLATION_CONSENT_PURPOSE,
        "version":1,"requestId":REQUEST,"offerNonce":OFFER,"requestDigest":"a".repeat(64),
        "principal":{"accountId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "personId":"owner","sessionEpoch":3},"consent":true})
}
fn human(value: &Json) -> HumanFrame {
    HumanFrame::decode(&serde_json::to_vec(value).unwrap()).unwrap()
}
fn decode(value: &Json) -> Result<PoolInstallationConsentRequest> {
    PoolInstallationConsentRequest::decode(&human(value))
}
fn reply() -> Json {
    let mut value = request();
    value["kind"] = json!("pool-installation-owner-current");
    value["nonce"] = json!(NONCE);
    value["ownerScopeDigest"] = json!("b".repeat(64));
    value["expiresAtEpochMs"] = json!(1_800_000_000_000_u64);
    value
}
#[test]
fn immutable_nomination_is_bound_separately_from_each_fresh_challenge() {
    let selected = decode(&request()).unwrap();
    let nonce = JournalId::parse(NONCE).unwrap();
    let challenge = selected.owner_challenge(&nonce).unwrap();
    let value: Json = serde_json::from_slice(&challenge.canonical().unwrap()).unwrap();
    assert_eq!(
        value,
        json!({"kind":"pool-installation-owner-check",
        "purpose":POOL_INSTALLATION_CONSENT_PURPOSE,"version":1,"requestId":REQUEST,
        "nonce":NONCE,"offerNonce":OFFER,"requestDigest":"a".repeat(64),
        "principal":request()["principal"]})
    );
    let original = selected
        .parse_owner_reply(&human(&reply()), &nonce)
        .unwrap();
    assert_eq!(original.principal(), selected.principal());
    assert_eq!(original.expires_at_epoch_ms(), 1_800_000_000_000);
    assert_eq!(selected, decode(&request()).unwrap());
    let next_nonce = JournalId::parse(OTHER).unwrap();
    assert!(
        selected
            .parse_owner_reply(&human(&reply()), &next_nonce)
            .is_err()
    );
    let mut next = reply();
    next["nonce"] = json!(OTHER);
    assert_eq!(
        original,
        selected
            .parse_owner_reply(&human(&next), &next_nonce)
            .unwrap()
    );
    assert!(selected.parse_owner_reply(&human(&next), &nonce).is_err());
}
#[test]
fn request_requires_explicit_true_exact_version_and_canonical_nonnil_identity() {
    for (name, bad) in [
        ("consent", json!(false)),
        ("consent", json!(1)),
        ("consent", json!("true")),
        ("version", json!(true)),
        ("version", json!(1.0)),
        ("version", json!("1")),
        ("version", json!(2)),
        ("requestId", json!("00000000-0000-0000-0000-000000000000")),
        ("offerNonce", json!("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")),
        ("requestDigest", json!("A".repeat(64))),
        ("employeeId", json!(OTHER)),
        ("granted", json!(true)),
        ("purpose", json!(RAM_POOL_PURPOSE)),
    ] {
        let mut changed = request();
        changed[name] = bad;
        assert!(decode(&changed).is_err(), "{name}");
    }
    for field in [
        "consent",
        "version",
        "principal",
        "offerNonce",
        "requestDigest",
    ] {
        let mut changed = request();
        changed.as_object_mut().unwrap().remove(field);
        assert!(decode(&changed).is_err(), "missing {field}");
    }
    for (name, bad) in [
        ("accountId", json!("00000000-0000-0000-0000-000000000000")),
        ("personId", json!("primary")),
        ("personId", json!("00000000-0000-0000-0000-000000000000")),
        ("sessionEpoch", json!(true)),
        ("sessionEpoch", json!(3.0)),
        ("sessionEpoch", json!("3")),
        ("sessionEpoch", json!(9_007_199_254_740_992_u64)),
        ("role", json!("owner")),
    ] {
        let mut changed = request();
        changed["principal"][name] = bad;
        assert!(decode(&changed).is_err(), "principal {name}");
    }
}
#[test]
fn current_reply_refuses_substitution_replay_expiry_coercion_and_extra_grants() {
    let selected = decode(&request()).unwrap();
    let nonce = JournalId::parse(NONCE).unwrap();
    for (name, bad) in [
        ("kind", json!("resource-owner-current")),
        ("purpose", json!(POOL_REGISTRATION_PURPOSE)),
        ("version", json!(true)),
        ("version", json!(1.0)),
        ("version", json!("1")),
        ("consent", json!(false)),
        ("consent", json!(1)),
        ("requestId", json!(OTHER)),
        ("nonce", json!(OTHER)),
        ("offerNonce", json!(OTHER)),
        ("requestDigest", json!("c".repeat(64))),
        ("ownerScopeDigest", json!("C".repeat(64))),
        ("expiresAtEpochMs", json!(0)),
        ("expiresAtEpochMs", json!(true)),
        ("expiresAtEpochMs", json!(1.0)),
        ("expiresAtEpochMs", json!("1800000000000")),
        ("expiresAtEpochMs", json!(9_007_199_254_740_992_u64)),
        ("hostPoolAdmin", json!(true)),
    ] {
        let mut changed = reply();
        changed[name] = bad;
        assert!(
            selected
                .parse_owner_reply(&human(&changed), &nonce)
                .is_err(),
            "{name}"
        );
    }
    for (name, changed) in [
        ("accountId", json!(OTHER)),
        ("personId", json!(OTHER)),
        ("sessionEpoch", json!(4)),
    ] {
        let mut value = reply();
        value["principal"][name] = changed;
        assert!(
            selected.parse_owner_reply(&human(&value), &nonce).is_err(),
            "principal {name}"
        );
    }
    let mut missing = reply();
    missing.as_object_mut().unwrap().remove("version");
    assert!(
        selected
            .parse_owner_reply(&human(&missing), &nonce)
            .is_err()
    );
}
#[test]
fn employee_approval_and_duplicate_lossless_frames_cannot_substitute_for_global_consent() {
    assert!(ResourceOperationRequest::decode(&human(&request())).is_err());
    assert!(decode_ram_pool_hello(&serde_json::to_vec(&request()).unwrap()).is_err());
    let raw = serde_json::to_string(&request()).unwrap();
    let duplicate = raw.replacen("{", "{\"consent\":false,", 1);
    assert!(HumanFrame::decode(duplicate.as_bytes()).is_err());
    assert!(PoolInstallationConsentRequest::decode(&human(&json!({
        "purpose":POOL_INSTALLATION_REQUEST_PURPOSE,"version":1,"principal":request()["principal"],
        "policy":{},
    }))).is_err());
}
