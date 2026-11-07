use reverie_contracts::{
    broker_laptop::BrokerLaptopInspection, worker_config, worker_schema::WorkerEnvelope,
};
use reverie_core::{ids::ProfileSessionId, worker_laptop::WorkerContainerName};
use serde_json::Value;
#[test]
fn actual_broker_reload_inspection_truthiness_ignored_rows_and_parser_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/broker-laptop-python.json")).unwrap();
    let config =
        worker_config::decode(&serde_json::to_vec(&fixture["configuration"]).unwrap()).unwrap();
    let policy = worker_config::policy_digest(&config);
    assert_eq!(policy.to_hex(), fixture["policy"].as_str().unwrap());
    let envelope = WorkerEnvelope::capture(config).unwrap();
    let session = ProfileSessionId::parse(fixture["session"].as_str().unwrap()).unwrap();
    let name = WorkerContainerName::for_session(envelope.base(), &session);
    assert_eq!(name.as_str(), format!("test-agent-{}", session.as_str()));
    for case in fixture["cases"].as_array().unwrap() {
        let result = BrokerLaptopInspection::decode(case["stdout"].as_str().unwrap().as_bytes())
            .and_then(|data| {
                match data.running_identity(envelope.base().deployment(), &session)? {
                    Some(running) => running.assert_policy(&policy),
                    None => Ok(()),
                }
            });
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(case["queries"], 1);
    }
}
#[test]
fn labels_refuse_before_caller_native_policy_resolution_and_stopped_rows_need_no_config() {
    use reverie_contracts::broker_laptop::LaptopReadError;
    let session = ProfileSessionId::parse("11111111-1111-4111-8111-111111111111").unwrap();
    let stopped = BrokerLaptopInspection::decode(br#"[{"State":{"Running":[]}}]"#).unwrap();
    assert!(
        stopped
            .running_identity("test", &session)
            .unwrap()
            .is_none()
    );
    let wrong = BrokerLaptopInspection::decode(
        br#"[{"State":{"Running":true},"Config":{"Labels":{"reverie.worker":"foreign"}}}]"#,
    )
    .unwrap();
    assert_eq!(
        wrong.running_identity("test", &session).err(),
        Some(LaptopReadError::Policy)
    );
    let malformed = BrokerLaptopInspection::decode(
        br#"[{"State":{"Running":true},"Config":{"Labels":"truthy"}}]"#,
    )
    .unwrap();
    assert_eq!(
        malformed.running_identity("test", &session).err(),
        Some(LaptopReadError::Structure)
    );
}
