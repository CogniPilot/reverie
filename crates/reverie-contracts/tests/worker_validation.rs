use reverie_contracts::worker_validation::{OpsBindingConfig, OpsPrivateDocument};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    raw_hex: String,
    accepted: bool,
    parse_accepted: bool,
}
fn bytes(raw: &str) -> Vec<u8> {
    raw.as_bytes()
        .chunks_exact(2)
        .map(|part| u8::from_str_radix(std::str::from_utf8(part).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn ops_metadata_uses_actual_python_bytes_encoding_and_strict_number_rules() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/worker_validation/ops-decoding.json")).unwrap();
    assert_eq!(cases.len(), 20);
    for case in cases {
        let raw = bytes(&case.raw_hex);
        let result = OpsBindingConfig::decode(&raw);
        assert_eq!(
            OpsPrivateDocument::decode(&raw).is_ok(),
            case.parse_accepted,
            "{} ordered purpose",
            case.name
        );
        assert_eq!(result.is_ok(), case.accepted, "{}", case.name);
        if let Ok(value) = result {
            assert_eq!(
                value.company_file().unwrap().scalar_text().as_deref(),
                Some("/synthetic/company.json")
            );
        }
    }
}

#[test]
fn goal_binding_values_are_lazy_and_keep_actual_python_source_order() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/worker_validation/goal-order.json")).unwrap();
    assert_eq!(cases.as_array().unwrap().len(), 8);
    for case in cases.as_array().unwrap() {
        let parsed = OpsPrivateDocument::decode(case["raw"].as_str().unwrap().as_bytes());
        assert_eq!(parsed.is_ok(), case["parsed"].as_bool().unwrap());
        let Ok(document) = parsed else { continue };
        let (actual, failed) = observe_hosts(&document);
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            case["hosts"],
            "{}",
            case["raw"]
        );
        assert_eq!(failed, !case["error"].is_null(), "{}", case["raw"]);
    }
}
fn observe_hosts(document: &OpsPrivateDocument) -> (Vec<String>, bool) {
    let Ok(values) = document.goal_hosts() else {
        return (Vec::new(), true);
    };
    let mut actual = Vec::new();
    for value in values {
        match value {
            Ok(value) => actual.push(value.scalar_text().unwrap()),
            Err(_) => return (actual, true),
        }
    }
    (actual, false)
}
