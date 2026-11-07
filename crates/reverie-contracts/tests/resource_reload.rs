use reverie_contracts::{resource_reload::OldPolicyStart, worker_config};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use serde_json::Value;

#[test]
fn actual_legacy_old6_candidate_and_refusal_vectors() {
    let reference: Value =
        serde_json::from_str(include_str!("fixtures/resource-reload-python.json")).unwrap();
    for case in reference["cases"].as_array().unwrap() {
        let before = worker_config::decode(&serde_json::to_vec(&case["before"]).unwrap()).unwrap();
        let projected =
            worker_config::decode(&serde_json::to_vec(&case["projected"]).unwrap()).unwrap();
        let result = OldPolicyStart::capture(
            before,
            projected,
            ProfileSessionId::parse(case["old"].as_str().unwrap()).unwrap(),
            ProfileSessionId::parse(case["target"].as_str().unwrap()).unwrap(),
        )
        .and_then(|start| {
            start.for_employee(
                &ProfileEmployeeId::parse(case["employee"].as_str().unwrap()).unwrap(),
            )
        })
        .and_then(|freeze| {
            assert!(
                case["accepted"].as_bool().unwrap(),
                "unexpectedly reached native OLD6 phase: {}",
                case["name"]
            );
            let old =
                worker_config::decode(&serde_json::to_vec(&case["oldEffective"]).unwrap()).unwrap();
            freeze.freeze(&old)
        });
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(result) = result {
            let expected =
                worker_config::decode(&serde_json::to_vec(&case["candidate"]).unwrap()).unwrap();
            assert!(
                worker_config::equivalent(result.candidate(), &expected),
                "{}",
                case["name"]
            );
        }
    }
}

#[test]
fn native_peer_order_is_original_insertion_order_while_hash_bytes_stay_sorted() {
    let raw=br#"{"sessionResources":{"ffffffff-ffff-4fff-8fff-ffffffffffff":{},"11111111-1111-4111-8111-111111111111":{}}}"#;
    let captured = worker_config::decode(raw).unwrap();
    let order = |config: &worker_config::EffectiveWorkerConfig| {
        config
            .session_resource_order()
            .iter()
            .map(|key| key.scalar_text().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        order(&captured),
        vec![
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
            "11111111-1111-4111-8111-111111111111"
        ]
    );
    assert_eq!(order(&captured), order(&captured.clone()));
    let sorted = worker_config::decode(&worker_config::encode_config(&captured)).unwrap();
    assert_ne!(order(&captured), order(&sorted));
    assert_eq!(
        worker_config::config_digest(&captured),
        worker_config::config_digest(&sorted)
    );
    assert!(worker_config::equivalent(&captured, &sorted));
    assert!(worker_config::decode(br#"{"sessionResources":{"z":0,"z":1}}"#).is_err());
    let owner =
        worker_config::decode_owner_text(br#"{"sessionResources":{"z":0,"a":1,"z":2}}"#).unwrap();
    assert_eq!(order(&owner), vec!["z", "a"]);
    let value: Value = serde_json::from_slice(&worker_config::encode_config(&owner)).unwrap();
    assert_eq!(value["sessionResources"]["z"], 2);
    // Merely capturing native-loop order cannot move session-key validation
    // into the lossless config/hash decoder.
    assert_eq!(
        order(&worker_config::decode(br#"{"sessionResources":{"not-a-sid":1}}"#).unwrap()),
        vec!["not-a-sid"]
    );
}
