use reverie_contracts::worker_storage::scratch_label_bytes;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

#[test]
fn descriptive_label_matches_actual_python_bytes_without_granting_ownership() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/storage-label-python.json")).unwrap();
    assert_eq!(corpus["cases"].as_array().unwrap().len(), 6);
    for case in corpus["cases"].as_array().unwrap() {
        let employee = case["employeeId"]
            .as_str()
            .map(|value| ProfileEmployeeId::parse(value).unwrap());
        let session = ProfileSessionId::parse(case["sessionId"].as_str().unwrap()).unwrap();
        let bytes = scratch_label_bytes(
            employee.as_ref(),
            &session,
            case["createdAt"].as_f64().unwrap(),
        )
        .unwrap();
        assert_eq!(bytes, case["bytes"].as_str().unwrap().as_bytes());
    }
    let session = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    for clock in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(scratch_label_bytes(None, &session, clock).is_err());
    }
}
