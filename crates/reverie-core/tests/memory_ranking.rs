use reverie_core::memory::{MemoryRank, memory_rank_order};
#[test]
fn actual_cpython_minrun_run_shape_gallop_and_unordered_key_vectors() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/memory-ranking-python.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let keys = case["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| MemoryRank {
                score: f64::from_bits(key[0].as_u64().unwrap()),
                created_at: f64::from_bits(key[1].as_u64().unwrap()),
            })
            .collect::<Vec<_>>();
        let expected = case["order"]
            .as_array()
            .unwrap()
            .iter()
            .map(|index| index.as_u64().unwrap() as usize)
            .collect::<Vec<_>>();
        assert_eq!(
            memory_rank_order(&keys).unwrap(),
            expected,
            "shape={}, n={}",
            case["shape"],
            keys.len()
        );
    }
}
