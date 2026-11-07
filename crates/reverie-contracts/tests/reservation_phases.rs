use reverie_contracts::reservation_engine::{InventoryRows, StoppedState};
use reverie_core::ids::ContainerId;
use serde::Deserialize;
#[derive(Deserialize)]
struct Case {
    name: String,
    kind: String,
    ordinary: String,
    raw: String,
    error: String,
}
#[test]
fn actual_python_stopped_preflight_and_whole_mount_shape_precede_later_work() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "fixtures/reservation-engine/phase-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 6);
    let id = ContainerId::parse(&"a".repeat(64)).unwrap();
    for case in cases {
        let result = if case.kind == "inventory" {
            InventoryRows::decode(std::slice::from_ref(&id), &[case.raw]).err()
        } else {
            let rows = InventoryRows::decode(std::slice::from_ref(&id), &[case.ordinary]).unwrap();
            if case.kind == "ordinary" {
                StoppedState::validate_ordinary(&rows.rows()[0]).err()
            } else {
                StoppedState::capture(&rows.rows()[0], &case.raw).err()
            }
        };
        assert_eq!(
            result.map(|error| error.code()),
            Some(case.error.as_str()),
            "{}",
            case.name
        );
    }
}
