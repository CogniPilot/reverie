use super::*;
use serde::Deserialize;
use std::collections::{BTreeMap, VecDeque};
#[derive(Deserialize)]
struct Case {
    name: String,
    reads: BTreeMap<String, Vec<String>>,
    row: serde_json::Value,
    policy: Option<serde_json::Value>,
    binding: Option<serde_json::Value>,
    error: Option<String>,
}
#[test]
fn actual_python_complete_controller_walk_and_binding_vectors_match_owned_reads() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../tests/fixtures/reservation-observer/limits-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 21);
    for case in cases {
        evaluate(case);
    }
}
fn evaluate(case: Case) {
    let fixture = Fixture::new();
    fs::remove_dir_all(fixture.root.join("proc")).unwrap();
    fs::remove_dir_all(fixture.root.join("cgroup")).unwrap();
    for (name, values) in case.reads {
        fixture.write(&name, values[0].as_bytes());
        fixture
            .scripted_reads
            .borrow_mut()
            .insert(path(&name).codepoints(), VecDeque::from(values));
    }
    let id = case.row["Id"].as_str().unwrap();
    let rows = InventoryRows::decode(&inventory_ids(id).unwrap(), &[case.row.to_string()]).unwrap();
    let policy = case.policy.map(|policy| {
        let config = json!({"memoryMiB":2048,"laptopMemoryPolicy":policy});
        ObservedMemoryPolicy::from_effective(
            &worker_config::decode(&serde_json::to_vec(&config).unwrap()).unwrap(),
        )
        .unwrap()
        .unwrap()
    });
    let result = limits::observe(&fixture, &rows.rows()[0], policy.as_ref(), end());
    assert_eq!(result.is_ok(), case.error.is_none(), "{}", case.name);
    match result {
        Ok(result) => assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&result.binding().canonical_bytes())
                .unwrap(),
            case.binding.unwrap(),
            "{}",
            case.name
        ),
        Err(error) => {
            if case.error.as_deref().unwrap().starts_with("RESERVATION_") {
                assert_eq!(error.code(), case.error.unwrap(), "{}", case.name);
            }
        }
    }
}
