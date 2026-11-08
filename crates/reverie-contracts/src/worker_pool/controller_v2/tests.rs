//! Pure schema controls only. These deliberately create DATA, never a native
//! broker, delegated process, installation, administration or maintenance grant.
use super::*;
use serde_json::json;
fn program() -> serde_json::Value {
    json!({"version":1,"purpose":PROGRAM_PURPOSE,"executable":"/nix/store/owned-program/bin/reverie-worker-broker",
        "executableSHA256":"a".repeat(64),"bytes":4096})
}
fn birth() -> ControllerBirthV2 {
    let policy = super::super::tests::policy();
    let broker = BrokerBirthData::from_observations(
        42,
        "123".into(),
        [policy.broker_uid, policy.broker_gid],
        [1, 2],
        [3, 4, 5],
        "b".repeat(64),
    )
    .unwrap();
    ControllerBirthV2::from_observations(
        policy,
        broker,
        BrokerProgramData::decode(&serde_json::to_vec(&program()).unwrap()).unwrap(),
    )
    .unwrap()
}
#[test]
fn v2_birth_data_roundtrips_without_widening_original_policy_schema() {
    let original = birth();
    let raw = original.encode().unwrap();
    assert!(ControllerBirthV2::decode(&raw).unwrap() == original);
    assert!(WorkerPoolPolicy::decode(&raw).is_err());
    let old = serde_json::to_vec(original.policy()).unwrap();
    assert!(WorkerPoolPolicy::decode(&old).unwrap() == *original.policy());
    assert!(ControllerBirthV2::decode(&old).is_err());
}
#[test]
fn v2_birth_refuses_unknown_fields_forged_versions_and_different_broker_ids() {
    let original: serde_json::Value = serde_json::from_slice(&birth().encode().unwrap()).unwrap();
    for (field, value) in [
        ("version", json!(1)),
        ("version", json!(2.0)),
        ("purpose", json!(PURPOSE)),
        ("available", json!(true)),
        ("maintenanceHeld", json!(true)),
        ("command", json!("arbitrary")),
    ] {
        let mut changed = original.clone();
        changed[field] = value;
        assert!(ControllerBirthV2::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    for (field, value) in [
        ("pid", json!(0)),
        ("pid", json!(1)),
        ("start", json!("0")),
        ("start", json!("01")),
        ("start", json!("18446744073709551616")),
        ("uid", json!(0)),
        ("uid", json!(1234)),
        ("gid", json!(0)),
        ("gid", json!(1234)),
        ("namespaces", json!([1, 0, 3])),
        ("executable", json!([1, 0])),
        ("argvSha256", json!("not-a-digest")),
        ("permission", json!(true)),
    ] {
        let mut changed = original.clone();
        changed["broker"][field] = value;
        assert!(
            ControllerBirthV2::decode(&serde_json::to_vec(&changed).unwrap()).is_err(),
            "{field}"
        );
    }
}
#[test]
fn immutable_broker_program_is_one_closed_native_role_not_an_executable_endpoint() {
    for path in [
        "/usr/bin/python",
        "/nix/store/../bin/reverie-worker-broker",
        "/nix/store/a/bin/reverie-worker-broker/extra",
        "/nix/store/a/bin/another-program",
        "/nix/store/a/bin/reverie-worker-broker\0",
    ] {
        let mut changed = program();
        changed["executable"] = json!(path);
        assert!(BrokerProgramData::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    for (key, value) in [
        ("version", json!(2)),
        ("bytes", json!(0)),
        ("bytes", json!(268435457)),
        ("purpose", json!("resource-replacement-native-client-v2")),
        ("argv", json!(["arbitrary"])),
        ("noSelfExec", json!(true)),
        ("executableSHA256", json!("x".repeat(64))),
    ] {
        let mut changed = program();
        changed[key] = value;
        assert!(BrokerProgramData::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
}
