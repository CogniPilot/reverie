use reverie_contracts::worker_config;
use reverie_contracts::worker_schema::{WorkerEnvelope, validate_rootless_mounts};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    raw: String,
    accepted: bool,
}
#[derive(Deserialize)]
struct Corpus {
    envelope: Vec<Case>,
    rootless: Vec<Case>,
}
fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/worker_schema/legacy.json")).unwrap()
}
#[test]
fn captured_envelope_matches_actual_legacy_worker_cases_without_mutation() {
    let cases = corpus().envelope;
    assert_eq!(cases.len(), 44);
    for case in cases {
        let config = worker_config::decode(case.raw.as_bytes()).unwrap();
        let before = worker_config::encode_config(&config);
        let result = WorkerEnvelope::capture(config);
        assert_eq!(result.is_ok(), case.accepted, "{}", case.name);
        if let Ok(envelope) = result {
            assert_eq!(
                worker_config::encode_config(envelope.configuration()),
                before,
                "{}",
                case.name
            );
            assert!(
                envelope.validate_feature_policies().is_ok(),
                "{}",
                case.name
            );
            assert_eq!(envelope.base().ids().uid(), 1000);
            assert_eq!(envelope.base().max_workers(), 1);
            assert_eq!(
                envelope.mounts()[0].source().scalar_text().unwrap(),
                "/synthetic/source"
            );
        }
    }
}
#[test]
fn pure_rootless_body_matches_actual_legacy_worker_cases() {
    let cases = corpus().rootless;
    assert_eq!(cases.len(), 67);
    for case in cases {
        let config = worker_config::decode(case.raw.as_bytes()).unwrap();
        assert_eq!(
            validate_rootless_mounts(&config).is_ok(),
            case.accepted,
            "{}",
            case.name
        );
    }
}
#[test]
fn shared_feature_checks_remain_separate_and_borrow_the_same_data() {
    let raw = &corpus().envelope[0].raw;
    let baseline: serde_json::Value = serde_json::from_str(raw).unwrap();
    for (field, value) in [
        ("employeeMemoryPolicies", serde_json::json!(false)),
        ("laptopSwapPoolMiB", serde_json::json!(true)),
        (
            "employeeGpuGrants",
            serde_json::json!({"opaque": "nvidia.com/gpu=all"}),
        ),
        (
            "employeePerfPolicies",
            serde_json::json!({"00000000-0000-0000-0000-000000000000":"task-v1"}),
        ),
        ("sessionResources", serde_json::json!({"opaque": {}})),
        ("leaseAcceptance", serde_json::json!({})),
    ] {
        let mut source = baseline.clone();
        source[field] = value;
        let config = worker_config::decode(&serde_json::to_vec(&source).unwrap()).unwrap();
        let envelope = WorkerEnvelope::capture(config).unwrap();
        let before = worker_config::encode_config(envelope.configuration());
        assert!(envelope.validate_feature_policies().is_err(), "{field}");
        assert_eq!(
            worker_config::encode_config(envelope.configuration()),
            before
        );
    }
}
#[test]
fn source_aliases_are_declarations_and_native_checks_are_still_required() {
    let mut source: serde_json::Value = serde_json::from_str(&corpus().envelope[0].raw).unwrap();
    source["mounts"][0]["source"] = serde_json::json!("//not-existing//./source/");
    let config = worker_config::decode(&serde_json::to_vec(&source).unwrap()).unwrap();
    let envelope = WorkerEnvelope::capture(config).unwrap();
    assert_eq!(
        envelope.mounts()[0].source().scalar_text().unwrap(),
        "//not-existing//./source/"
    );
    // This value has not checked existence, control-root exposure or attachments.
    assert!(!envelope.mounts()[0].read_only());
}
