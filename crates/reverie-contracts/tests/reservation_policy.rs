use reverie_contracts::{
    reservation_policy::{PolicyAttemptRecord, PolicyCandidateData},
    worker_config,
};
use reverie_core::operations::JournalId;
use serde_json::Value;
#[test]
fn actual_python_compact_bytes_hashes_attempts_and_refusals() {
    let reference: Value =
        serde_json::from_str(include_str!("fixtures/reservation-policy-python.json")).unwrap();
    let operation = JournalId::parse(reference["operation"].as_str().unwrap()).unwrap();
    let before = worker_config::decode(&serde_json::to_vec(&reference["before"]).unwrap()).unwrap();
    for case in reference["cases"].as_array().unwrap() {
        let raw = if let Some(size) = case["size"].as_u64() {
            format!("{{\"x\":\"{}\"}}", "a".repeat(size as usize))
        } else {
            case["input"].as_str().unwrap().to_owned()
        };
        let config = worker_config::decode(raw.as_bytes()).unwrap();
        let candidate = PolicyCandidateData::capture(&config);
        assert_eq!(
            candidate.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(candidate) = candidate {
            if case["size"].is_null() {
                assert_eq!(
                    candidate.bytes(),
                    case["bytes"].as_str().unwrap().as_bytes(),
                    "{}",
                    case["name"]
                );
            } else {
                assert_eq!(
                    candidate.bytes().len() as u64,
                    case["encodedLength"].as_u64().unwrap()
                );
            }
            assert_eq!(
                candidate.digest().as_str(),
                case["digest"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            let attempt =
                PolicyAttemptRecord::from_observed_data(&operation, &before, &candidate).unwrap();
            assert_eq!(attempt.operation_id(), &operation);
            assert_eq!(
                attempt.canonical_bytes(),
                case["attempt"].as_str().unwrap().as_bytes(),
                "{}",
                case["name"]
            );
        }
    }
}
#[test]
fn actual_preparation_receipt_from_owned_policy_cas_and_broker_reload_has_exact_bytes() {
    use reverie_contracts::{
        operations_v1, profiles_v1,
        reservation_policy::{PreparedPolicyFields, PreparedPolicyRecord},
    };
    use reverie_core::operations::JournalDigest;
    let reference: Value = serde_json::from_str(include_str!(
        "fixtures/reservation-policy-prepared-python.json"
    ))
    .unwrap();
    let document =
        operations_v1::decode(&serde_json::to_vec(&reference["document"]).unwrap()).unwrap();
    let profiles =
        profiles_v1::decode(&serde_json::to_vec(&reference["profiles"]).unwrap()).unwrap();
    let before = worker_config::decode(&serde_json::to_vec(&reference["before"]).unwrap()).unwrap();
    let after =
        worker_config::decode(&serde_json::to_vec(&reference["candidate"]).unwrap()).unwrap();
    let after = PolicyCandidateData::capture(&after).unwrap();
    let expected: Value =
        serde_json::from_str(reference["receiptBytes"].as_str().unwrap()).unwrap();
    let source = JournalDigest::parse(expected["sourceBindingDigest"].as_str().unwrap()).unwrap();
    let operation = document.operations().values().next().unwrap();
    let record = PreparedPolicyRecord::from_observed_data(PreparedPolicyFields {
        operation,
        profile: profiles.profiles().values().next().unwrap(),
        before: &before,
        after: &after,
        source_binding: &source,
    })
    .unwrap();
    assert_eq!(record.operation_id(), &operation.data().id);
    assert_eq!(
        record.canonical_bytes(),
        reference["receiptBytes"].as_str().unwrap().as_bytes()
    );
    assert_eq!(
        record.digest().as_str(),
        reference["receiptDigest"].as_str().unwrap()
    );
}
