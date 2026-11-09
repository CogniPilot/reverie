//! New provider selection is closed data, never a maintenance/admission grant.
use super::*;
use crate::worker_config;

fn selected() -> serde_json::Value {
    serde_json::json!({
        "version":1,
        "purpose":"reverie-docker-worker-pool-provider-v1",
        "policy":policy()
    })
}
fn configuration(value: serde_json::Value) -> worker_config::EffectiveWorkerConfig {
    worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap()
}
#[test]
fn legacy_configuration_remains_unselected_and_byte_identical() {
    let config = configuration(serde_json::json!({"cgroupParent":"reverie-workers.slice"}));
    let before = worker_config::encode_config(&config);
    assert!(WorkerPoolProvider::from_config(&config).unwrap().is_none());
    assert_eq!(before, worker_config::encode_config(&config));
}
#[test]
fn explicit_provider_preserves_the_full_validated_policy() {
    let config = configuration(serde_json::json!({"workerPoolProvider":selected()}));
    let provider = WorkerPoolProvider::from_config(&config).unwrap().unwrap();
    assert_eq!(provider.policy(), &policy());
}
#[test]
fn malformed_or_authority_claiming_provider_never_falls_back_to_legacy() {
    let mut extra = selected();
    extra["ready"] = serde_json::json!(true);
    let mut wrong_version = selected();
    wrong_version["version"] = serde_json::json!(2);
    let mut wrong_purpose = selected();
    wrong_purpose["purpose"] = serde_json::json!(PURPOSE);
    let mut invalid_policy = selected();
    invalid_policy["policy"]["memoryMaxMiB"] = serde_json::json!(0);
    for value in [
        serde_json::Value::Null,
        serde_json::json!({}),
        extra,
        wrong_version,
        wrong_purpose,
        invalid_policy,
    ] {
        let config = configuration(serde_json::json!({"workerPoolProvider":value}));
        assert!(WorkerPoolProvider::from_config(&config).is_err());
    }
}
