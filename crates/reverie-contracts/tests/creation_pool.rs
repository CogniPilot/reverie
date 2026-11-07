use reverie_contracts::creation_budget::check_pool_counters;
use serde_json::Value;
#[test]
fn actual_worker_input_cannot_author_a_candidate_memory_projection() {
    use reverie_contracts::{
        worker_config,
        worker_schema::{WorkerEnvelope, WorkerSchemaError},
    };
    let oracle: Value = serde_json::from_str(include_str!(
        "fixtures/creation-candidate-domain-python.json"
    ))
    .unwrap();
    assert_eq!(oracle["baseValidated"], true);
    assert_eq!(
        oracle["extraRejected"]["message"],
        "Unsupported worker configuration"
    );
    let text = oracle["configText"]
        .as_str()
        .unwrap()
        .replace("$ROOT", "/synthetic");
    let config = worker_config::decode(text.as_bytes()).unwrap();
    assert!(matches!(
        WorkerEnvelope::capture(config),
        Err(WorkerSchemaError::Header)
    ));
}
#[test]
fn pool_check_matches_23_actual_python_signed_zero_unicode_and_headroom_cases() {
    let oracle: Value =
        serde_json::from_str(include_str!("fixtures/creation-pool-python.json")).unwrap();
    for case in oracle["cases"].as_array().unwrap() {
        let result = check_pool_counters(
            case["memory"].as_str().unwrap(),
            case["tasks"].as_str().unwrap(),
            case["current"].as_str().unwrap(),
            4 * 1024 * 1024 * 1024,
            1024,
            case["headroom"].as_bool().unwrap(),
        );
        assert_eq!(
            result.err().map(|error| error.code()),
            case["error"]["message"].as_str(),
            "{}",
            case["name"]
        );
    }
}
