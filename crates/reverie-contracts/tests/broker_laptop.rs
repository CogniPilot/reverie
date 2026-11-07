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

#[test]
fn ordinary_launch_labels_precede_running_and_keep_reload_disposition_separate() {
    use reverie_contracts::broker_laptop::{LaptopReadError, LaunchLaptopInspection};
    let sid = ProfileSessionId::parse("11111111-1111-4111-8111-111111111111").unwrap();
    for labels in ["null", "false", "[]", "\"\"", "0"] {
        let raw = format!(r#"[{{"Config":{{"Labels":{labels}}},"State":{{"Running":false}}}}]"#);
        assert!(matches!(
            LaunchLaptopInspection::decode_owned(raw.as_bytes(), "test", &sid),
            Err(LaptopReadError::Structure)
        ));
        assert!(
            BrokerLaptopInspection::decode(raw.as_bytes())
                .unwrap()
                .running_identity("test", &sid)
                .unwrap()
                .is_none()
        );
    }
    // Foreign labels win over missing/malformed State. Stopped rows are still
    // rejected by launch, unlike the earlier reload-purpose reader.
    assert!(matches!(
        LaunchLaptopInspection::decode_owned(br#"[{"Config":{"Labels":{}}}]"#, "test", &sid),
        Err(LaptopReadError::Ownership)
    ));
    let prefix = r#""Config":{"Labels":{"reverie.worker":"test","reverie.session":"11111111-1111-4111-8111-111111111111"}}"#;
    for (running, wanted) in [
        ("[]", false),
        ("{}", false),
        ("null", false),
        ("0", false),
        ("\"\"", false),
        ("[0]", true),
        ("-1", true),
        ("NaN", true),
        ("\"yes\"", true),
    ] {
        let raw = format!(r#"[{{{prefix},"State":{{"Running":{running}}}}},{{"ignored":true}}]"#);
        let read = LaunchLaptopInspection::decode_owned(raw.as_bytes(), "test", &sid).unwrap();
        assert_eq!(read.running().unwrap(), wanted, "{running}");
        assert!(read.canonical_id().is_none());
    }
}

#[test]
fn ordinary_launch_candidate_id_is_optional_and_running_policy_is_separate() {
    use reverie_contracts::broker_laptop::LaunchLaptopInspection;
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/broker-laptop-python.json")).unwrap();
    let config =
        worker_config::decode(&serde_json::to_vec(&fixture["configuration"]).unwrap()).unwrap();
    let sid = ProfileSessionId::parse("11111111-1111-4111-8111-111111111111").unwrap();
    let policy = worker_config::policy_digest(&config);
    for id in [
        serde_json::json!("a".repeat(64)),
        serde_json::json!("A".repeat(64)),
        serde_json::json!(null),
        serde_json::json!(17),
    ] {
        let row = serde_json::json!([{"Id":id,"State":{"Running":true},"Config":{"Labels":{"reverie.worker":"test","reverie.session":sid.as_str(),"reverie.worker-policy":policy.to_hex()}}}]);
        let read =
            LaunchLaptopInspection::decode_owned(&serde_json::to_vec(&row).unwrap(), "test", &sid)
                .unwrap();
        assert!(read.running().unwrap());
        read.assert_running_policy(&policy).unwrap();
        assert_eq!(
            read.canonical_id().is_some(),
            id == serde_json::json!("a".repeat(64))
        );
    }
}

#[test]
fn original_handle_first_inspect_ast_phase_vectors_match_launch_view() {
    use reverie_contracts::broker_laptop::LaunchLaptopInspection;
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/launch-first-inspect-python.json")).unwrap();
    let sid = ProfileSessionId::parse("11111111-1111-4111-8111-111111111111").unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let read = LaunchLaptopInspection::decode_owned(
            case["stdout"].as_str().unwrap().as_bytes(),
            "test",
            &sid,
        );
        let actual = read.and_then(|row| row.running());
        assert_eq!(
            actual.is_ok(),
            case["outcome"]["accepted_to_runtime_phase"]
                .as_bool()
                .unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(running) = actual {
            assert_eq!(
                running,
                case["outcome"]["running"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
