use reverie_contracts::reservation_engine::{InventoryRows, StoppedState, inventory_ids};
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inventory {
    name: String,
    ids: String,
    batches: Vec<String>,
    accepted: bool,
    row_hashes: Vec<Option<String>>,
    mount_hashes: Vec<String>,
}
#[derive(Deserialize)]
struct Stop {
    name: String,
    ordinary: String,
    raw: String,
    accepted: bool,
    state: Option<String>,
}
#[derive(Deserialize)]
struct Corpus {
    inventory: Vec<Inventory>,
    stopped: Vec<Stop>,
}
fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/reservation-engine/python.json")).unwrap()
}
#[test]
fn actual_python_complete_inventory_preserves_every_mount_and_unknown_row_field() {
    let cases = corpus().inventory;
    assert_eq!(cases.len(), 16);
    for case in cases {
        let result =
            inventory_ids(&case.ids).and_then(|ids| InventoryRows::decode(&ids, &case.batches));
        assert_eq!(result.is_ok(), case.accepted, "{}", case.name);
        if let Ok(rows) = result {
            assert_eq!(
                rows.rows()
                    .iter()
                    .map(|row| row.snapshot_digest().ok().map(|hash| hash.to_hex()))
                    .collect::<Vec<_>>(),
                case.row_hashes,
                "{}",
                case.name
            );
            assert_eq!(
                rows.rows()
                    .iter()
                    .map(|row| row.mounts_digest().unwrap().to_hex())
                    .collect::<Vec<_>>(),
                case.mount_hashes,
                "{}",
                case.name
            );
        }
    }
}
#[test]
fn actual_python_fresh_stopped_metadata_joins_exact_ordinary_projection() {
    let cases = corpus().stopped;
    assert_eq!(cases.len(), 9);
    for case in cases {
        let ids = inventory_ids(&"a".repeat(64)).unwrap();
        let rows = InventoryRows::decode(&ids, &[case.ordinary]).unwrap();
        let result = StoppedState::capture(&rows.rows()[0], &case.raw);
        assert_eq!(result.is_ok(), case.accepted, "{}", case.name);
        if let Ok(state) = result {
            assert_eq!(
                String::from_utf8(state.state_bytes()).unwrap(),
                case.state.unwrap(),
                "{}",
                case.name
            );
        }
    }
}
