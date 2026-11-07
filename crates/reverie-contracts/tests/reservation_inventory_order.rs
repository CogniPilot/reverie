//! Actual legacy NativeObserver inventory ordering counterexamples.
use reverie_contracts::reservation_engine::{InventoryDecoder, InventoryRows};
use reverie_core::ids::ContainerId;

fn code(ids: &[&str], raw: &str) -> Option<&'static str> {
    let ids = ids
        .iter()
        .map(|id| ContainerId::parse(id).unwrap())
        .collect::<Vec<_>>();
    InventoryRows::decode(&ids, &[raw.to_owned()])
        .err()
        .map(|error| error.code())
}

#[test]
fn non_object_row_is_complete_inventory_refusal() {
    let a = "a".repeat(64);
    assert_eq!(code(&[&a], "[]"), Some("RESERVATION_COMPLETE_INVENTORY"));
}

#[test]
fn global_id_check_precedes_any_mount_validation() {
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let c = "c".repeat(64);
    let raw = format!("{{\"Id\":\"{a}\",\"Mounts\":null}}\n{{\"Id\":\"{c}\",\"Mounts\":[]}}");
    assert_eq!(
        code(&[&a, &b], &raw),
        Some("RESERVATION_COMPLETE_INVENTORY")
    );
}

#[test]
fn every_json_line_is_parsed_before_any_mount_validation() {
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let raw = format!("{{\"Id\":\"{a}\",\"Mounts\":null}}\n{{");
    assert_eq!(code(&[&a, &b], &raw), Some("RESERVATION_ENGINE_JSON"));
}
#[test]
fn failed_incremental_batch_cannot_be_replaced_or_finished_as_valid() {
    let ids = [ContainerId::parse(&"a".repeat(64)).unwrap()];
    let mut decoder = InventoryDecoder::new(&ids).unwrap();
    assert_eq!(
        decoder.push("{").err().unwrap().code(),
        "RESERVATION_ENGINE_JSON"
    );
    assert_eq!(
        decoder
            .push(&format!("{{\"Id\":\"{}\",\"Mounts\":[]}}", ids[0].as_str()))
            .err()
            .unwrap()
            .code(),
        "RESERVATION_ENGINE_JSON"
    );
    assert_eq!(
        decoder.finish().err().unwrap().code(),
        "RESERVATION_ENGINE_JSON"
    );
}
