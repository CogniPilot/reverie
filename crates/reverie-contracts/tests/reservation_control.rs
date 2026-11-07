//! Original Gate constructor's DATA checks; file readiness/admission is native.
use reverie_contracts::{
    reservation_control::{self, ControlBinding},
    storage_identity::decode_ordered_metadata,
    worker_config,
};
use serde::Deserialize;
#[derive(Deserialize)]
struct Case {
    name: String,
    config: String,
    marker: String,
    error: Option<String>,
    domain: Option<String>,
    order: Option<Vec<String>>,
}
#[test]
fn original_python_control_binding_and_domain_vectors_keep_exact_source_rules() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/reservation-control-python.json")).unwrap();
    assert_eq!(cases.len(), 24);
    for case in cases {
        let config = worker_config::decode(case.config.as_bytes()).unwrap();
        assert_eq!(
            reservation_control::domain_digest(&config)
                .ok()
                .map(|value| value.to_hex()),
            case.domain,
            "{}",
            case.name
        );
        let metadata = decode_ordered_metadata(case.marker.as_bytes()).unwrap();
        let result = ControlBinding::from_metadata(&metadata, &config);
        assert_eq!(
            result.as_ref().err().map(|error| error.code()),
            case.error.as_deref(),
            "{}",
            case.name
        );
        if let Ok(binding) = result {
            assert_eq!(
                binding
                    .directory_order()
                    .iter()
                    .map(|value| value.name().to_owned())
                    .collect::<Vec<_>>(),
                case.order.unwrap(),
                "{}",
                case.name
            );
            assert!(binding.matches_metadata(&metadata));
        }
    }
}
