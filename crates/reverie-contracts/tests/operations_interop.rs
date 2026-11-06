use reverie_contracts::operations_v1;
use reverie_core::operations::Effect;
use serde_json::Value;
use sha2::{Digest, Sha256};
fn hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|part| u8::from_str_radix(std::str::from_utf8(part).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn actual_python_closed_ledger_acceptance_bytes_hashes_and_refusals_match() {
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/operation-journal-python-interop.json"
    ))
    .unwrap();
    assert_eq!(fixture["cases"].as_array().unwrap().len(), 91);
    for case in fixture["cases"].as_array().unwrap() {
        let result = operations_v1::decode(&hex(case["rawHex"].as_str().unwrap()));
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        match result {
            Ok(document) => {
                let raw = operations_v1::encode(&document).unwrap();
                assert_eq!(
                    raw,
                    case["canonical"].as_str().unwrap().as_bytes(),
                    "{} bytes",
                    case["name"]
                );
                assert_eq!(
                    format!("{:x}", Sha256::digest(raw)),
                    case["sha256"].as_str().unwrap(),
                    "{} hash",
                    case["name"]
                );
            }
            Err(error) => assert_eq!(
                error.code(),
                case["code"].as_str().unwrap(),
                "{} refusal",
                case["name"]
            ),
        }
    }
}
#[test]
fn named_request_and_observation_fingerprints_share_the_existing_canonical_owner() {
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/operation-journal-python-interop.json"
    ))
    .unwrap();
    let request =
        operations_v1::decode_request(fixture["request"].as_str().unwrap().as_bytes()).unwrap();
    let observation =
        operations_v1::decode_observation(fixture["observation"].as_str().unwrap().as_bytes())
            .unwrap();
    assert_eq!(
        operations_v1::request_digest(&request).as_str(),
        fixture["requestDigest"].as_str().unwrap()
    );
    assert_eq!(
        operations_v1::observation_digest(&observation).as_str(),
        fixture["observationDigest"].as_str().unwrap()
    );
    assert!(operations_v1::decode_scope(fixture["scope"].as_str().unwrap().as_bytes()).is_ok());
}
#[test]
fn checked_phase_transitions_never_turn_acknowledgement_into_native_completion() {
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/operation-journal-python-interop.json"
    ))
    .unwrap();
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "reserved")
        .unwrap();
    let document = operations_v1::decode(&hex(case["rawHex"].as_str().unwrap())).unwrap();
    let mut operation = document.operations().values().next().unwrap().clone();
    let receipt = operation.data().request.preview_digest.clone();
    for effect in [Effect::Prepare, Effect::Start, Effect::Verify] {
        assert!(operation.acknowledge(effect, receipt.clone()).is_err());
        operation = operation.begin(effect).unwrap();
        assert!(operation.begin(effect).is_err());
        operation = operation.acknowledge(effect, receipt.clone()).unwrap();
    }
    assert_eq!(operation.data().version.get(), 7);
    assert_eq!(operation.data().state.name(), "VERIFY_RECORDED");
    assert_eq!(operation.data().delta_bytes, 16 * 1048576);
}

#[test]
fn failed_ordered_document_builder_cannot_return_a_partial_valid_document() {
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/operation-journal-python-interop.json"
    ))
    .unwrap();
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "reserved")
        .unwrap();
    let document = operations_v1::decode(&hex(case["rawHex"].as_str().unwrap())).unwrap();
    let (id, op) = document.operations().first_key_value().unwrap();
    let mut builder = reverie_core::operations::OperationDocumentBuilder::new(document.revision());
    builder.push_unique(id.clone(), op.clone()).unwrap();
    assert!(builder.push_unique(id.clone(), op.clone()).is_err());
    assert!(builder.finish().is_err());
}
