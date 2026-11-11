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
fn decoder_acknowledgement_matches_the_actual_producer_and_refuses_stale_or_downgraded_replies() {
    let original = birth();
    let provider = committed(&original, 7, json!({}));
    let anchor = serde_json::from_value(json!({
        "containerId":"a".repeat(64),"originalBirthDigest":"b".repeat(64),
        "bootId":"11111111-1111-4111-8111-111111111111","pid":42,"processStart":"100",
        "parentIdentity":[12,22],"leafIdentity":[12,27]
    }))
    .unwrap();
    let retained =
        ControllerServiceBirth::from_installed_provider(original.clone(), &provider, Some(anchor))
            .unwrap()
            .encode()
            .unwrap();
    assert!(ControllerBirthV2::decode(&retained).is_err());
    let checked = ControllerBirthCheck::from_birth(&retained).unwrap();
    let reply = checked.encode().unwrap();
    assert_eq!(
        ControllerBirthCheck::verify_reply(&reply, &retained).unwrap(),
        checked
    );
    for (name, replacement) in [
        ("birthVersion", json!(2)),
        ("retainedAnchor", json!(false)),
        ("memberRevision", json!(8)),
        ("birthSha256", json!("c".repeat(64))),
        ("purpose", json!("other")),
        ("version", json!(2)),
    ] {
        let mut changed: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        changed[name] = replacement;
        assert!(
            ControllerBirthCheck::verify_reply(&serde_json::to_vec(&changed).unwrap(), &retained)
                .is_err()
        );
    }
    assert!(ControllerBirthCheck::verify_reply(&reply, &original.encode().unwrap()).is_err());
    let duplicate = String::from_utf8(reply)
        .unwrap()
        .replacen("{", "{\"version\":1,", 1);
    assert!(ControllerBirthCheck::verify_reply(duplicate.as_bytes(), &retained).is_err());
}

fn committed(
    birth: &ControllerBirthV2,
    revision: u64,
    overrides: serde_json::Value,
) -> WorkerPoolProvider {
    let data = json!({"workerPoolProvider": {
        "version": 2,
        "purpose": "reverie-docker-worker-pool-provider-v2",
        "policy": birth.policy(),
        "memberRevision": revision,
        "memberOverrides": overrides
    }});
    let configuration = crate::worker_config::decode(&serde_json::to_vec(&data).unwrap()).unwrap();
    WorkerPoolProvider::from_config(&configuration)
        .unwrap()
        .unwrap()
}

#[test]
fn restored_birth_roundtrips_nonzero_revision_with_or_without_overrides() {
    let birth = birth();
    let employee = birth
        .policy()
        .employee_memory_high_mi_b
        .keys()
        .next()
        .unwrap();
    let changed = json!({employee: {"memoryHighMiB": 8192, "cpuWeight": 200}});
    for (revision, overrides) in [(7, changed), (8, json!({}))] {
        let provider = committed(&birth, revision, overrides);
        let restored =
            ControllerServiceBirth::from_installed_provider(birth.clone(), &provider, None)
                .unwrap();
        let raw = restored.encode().unwrap();
        assert!(ControllerBirthV2::decode(&raw).is_err());
        let decoded = ControllerServiceBirth::decode(&raw).unwrap();
        assert!(decoded.identity() == &birth);
        assert!(decoded.retained_anchor().is_none());
        let snapshot = decoded.member_snapshot().unwrap();
        assert_eq!(snapshot.revision(), revision);
        assert_eq!(snapshot.overrides(), provider.member_overrides());
    }
    let original = birth.encode().unwrap();
    assert_eq!(
        ControllerServiceBirth::from(birth).encode().unwrap(),
        original
    );
    assert!(
        !ControllerServiceBirth::decode(&original)
            .unwrap()
            .restored()
    );
}

#[test]
fn restored_birth_refuses_missing_edited_revision_and_forged_override_data() {
    let birth = birth();
    let employee = "22222222-2222-4222-8222-222222222222";
    let provider = committed(
        &birth,
        7,
        json!({employee: {"memoryHighMiB": 8192, "cpuWeight": 200}}),
    );
    let raw = ControllerServiceBirth::from_installed_provider(birth, &provider, None)
        .unwrap()
        .encode()
        .unwrap();
    let original: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    let mut missing = original.clone();
    missing.as_object_mut().unwrap().remove("members");
    assert!(ControllerServiceBirth::decode(&serde_json::to_vec(&missing).unwrap()).is_err());
    for members in [
        json!(null),
        json!({"revision": 0, "overrides": {}}),
        json!({"revision": 7, "overrides": {"55555555-5555-4555-8555-555555555555": {"memoryHighMiB": 8192, "cpuWeight": 200}}}),
        json!({"revision": 7, "overrides": {employee: {"memoryHighMiB": 49152, "cpuWeight": 200}}}),
        json!({"revision": 7, "overrides": {employee: {"memoryHighMiB": 8192, "cpuWeight": 200}}, "confirmed": true}),
    ] {
        let mut malformed = original.clone();
        malformed["members"] = members;
        assert!(ControllerServiceBirth::decode(&serde_json::to_vec(&malformed).unwrap()).is_err());
    }
    let entry = format!(r#""{employee}":{{"memoryHighMiB":8192,"cpuWeight":200}}"#);
    let original = String::from_utf8(raw).unwrap();
    let duplicate = original.replacen(&entry, &format!("{entry},{entry}"), 1);
    assert_ne!(original, duplicate);
    assert!(ControllerServiceBirth::decode(duplicate.as_bytes()).is_err());
}

#[test]
fn retained_anchor_can_restore_a_v1_or_v2_provider() {
    let birth = birth();
    let anchor: RetainedPoolAnchor = serde_json::from_value(json!({
        "containerId":"f".repeat(64),"originalBirthDigest":"e".repeat(64),
        "bootId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "pid":430,"processStart":"70000","parentIdentity":[12,22],"leafIdentity":[12,27]
    }))
    .unwrap();
    let legacy = json!({"workerPoolProvider": {
        "version":1,"purpose":"reverie-docker-worker-pool-provider-v1","policy":birth.policy()
    }});
    let configuration =
        crate::worker_config::decode(&serde_json::to_vec(&legacy).unwrap()).unwrap();
    let legacy = WorkerPoolProvider::from_config(&configuration)
        .unwrap()
        .unwrap();
    let edited = committed(&birth, 8, json!({}));
    assert!(ControllerServiceBirth::from_installed_provider(birth.clone(), &legacy, None).is_err());
    for provider in [legacy, edited] {
        let restored = ControllerServiceBirth::from_installed_provider(
            birth.clone(),
            &provider,
            Some(anchor.clone()),
        )
        .unwrap();
        let decoded = ControllerServiceBirth::decode(&restored.encode().unwrap()).unwrap();
        assert_eq!(decoded.retained_anchor(), Some(&anchor));
        assert_eq!(
            decoded.member_snapshot().map(|members| members.revision()),
            (provider.member_revision() > 0).then(|| provider.member_revision()),
        );
    }
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
