use reverie_contracts::{
    operations_v1,
    reservation_baseline::{
        OriginalBaselineFields, OriginalRuntimeTail, OriginalSourceBaseline, StartIntentRecord,
    },
    reservation_engine::{InventoryRows, NativeLimitBinding, NativeStorageBinding, inventory_ids},
};
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath};
use serde::Deserialize;
#[derive(Deserialize)]
struct Case {
    name: String,
    source: String,
    canonical: Option<String>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct State {
    raw: String,
    running: bool,
    stopped: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    operation_document: String,
    cases: Vec<Case>,
    states: Vec<State>,
}
fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/protected-start-python.json")).unwrap()
}
fn rows(raw: &str) -> InventoryRows {
    InventoryRows::decode(&inventory_ids(&"a".repeat(64)).unwrap(), &[raw.into()]).unwrap()
}
fn baseline(rows: &InventoryRows) -> OriginalSourceBaseline {
    let row = &rows.rows()[0];
    let zero = UnsignedInteger::from_u64(0);
    let native = NativeLimitBinding::from_observed_data(
        row,
        &row.declarations(&zero).unwrap(),
        "77",
        &PosixPath::from_scalar_text("owned"),
        None,
    )
    .unwrap();
    OriginalSourceBaseline::from_observed_data(OriginalBaselineFields {
        source: row,
        native: &native,
        storage: &NativeStorageBinding::from_observed_data([
            [1, 2, 3, 4],
            [5, 6, 7, 8],
            [9, 10, 11, 12],
        ]),
        site: &native,
        commitments: std::slice::from_ref(&native),
        total: &UnsignedInteger::from_u64(536_870_912),
        budget: &UnsignedInteger::from_u64(1_073_741_824),
        runtime: &OriginalRuntimeTail::from_observed_data([3, 4], vec![]),
    })
}
#[test]
fn actual_python_start_intent_bytes_preserve_numeric_kind_unicode_and_late_nonfinite_failure() {
    let corpus = corpus();
    assert_eq!(corpus.cases.len(), 5);
    let document = operations_v1::decode(corpus.operation_document.as_bytes()).unwrap();
    let operation = document
        .operations()
        .values()
        .find(|operation| {
            operation.data().state == reverie_core::operations::OperationState::Starting
        })
        .unwrap();
    for case in corpus.cases {
        let baseline = baseline(&rows(&case.source));
        match StartIntentRecord::from_observed_data(operation, &baseline) {
            Ok(record) => {
                assert_eq!(
                    Some(record.canonical_bytes()),
                    case.canonical.as_deref().map(str::as_bytes),
                    "{}",
                    case.name
                );
                assert_eq!(case.error, None);
            }
            Err(error) => assert_eq!(Some(error.code()), case.error.as_deref(), "{}", case.name),
        }
    }
}
#[test]
fn python_state_equality_is_preserved_before_later_strict_native_capacity_rules() {
    let corpus = corpus();
    assert_eq!(corpus.states.len(), 11);
    let source = &corpus.cases[0].source;
    let baseline = baseline(&rows(source));
    for case in corpus.states {
        let raw = source.replace(
            "\"State\":{\"Running\":true,\"Pid\":123}",
            &format!("\"State\":{}", case.raw),
        );
        assert!(
            source.contains("\"State\":{\"Running\":true,\"Pid\":123}"),
            "state substitution must select the actual fixture field"
        );
        let current = rows(&raw);
        assert_eq!(
            baseline.start_source_running(&current.rows()[0]).unwrap(),
            case.running,
            "{}",
            case.raw
        );
        assert_eq!(
            baseline
                .assert_old_stopped_state(&current.rows()[0])
                .is_ok(),
            case.stopped,
            "{}",
            case.raw
        );
    }
}
