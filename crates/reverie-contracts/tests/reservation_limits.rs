use reverie_contracts::reservation_engine::InventoryRows;
use reverie_core::{decimal::UnsignedInteger, ids::ContainerId};
use serde::Deserialize;
#[derive(Deserialize)]
struct Case {
    name: String,
    kind: String,
    raw: String,
    error: Option<String>,
}
#[test]
fn actual_python_pid_and_stopped_website_diagnostics_keep_their_rule_owner() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "fixtures/reservation-engine/limits-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 17);
    let id = ContainerId::parse(&"a".repeat(64)).unwrap();
    for case in cases {
        let inventory = InventoryRows::decode(std::slice::from_ref(&id), &[case.raw]).unwrap();
        let row = &inventory.rows()[0];
        let error = if case.kind == "pid" {
            row.declarations(&UnsignedInteger::from_u64(0)).err()
        } else {
            row.stopped_website(&id).err()
        };
        assert_eq!(
            error.map(|error| error.code()),
            case.error.as_deref(),
            "{}",
            case.name
        );
    }
}
