use reverie_contracts::{
    worker_config,
    worker_recovery::{RecoveryInspection, RecoveryInspectionNeed, RecoveryNames},
    worker_schema::WorkerEnvelope,
};
use serde_json::Value;
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/worker-recovery-python.json")).unwrap()
}
fn base() -> reverie_core::worker_schema::WorkerBase {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/broker-laptop-python.json")).unwrap();
    WorkerEnvelope::capture(
        worker_config::decode(&serde_json::to_vec(&fixture["configuration"]).unwrap()).unwrap(),
    )
    .unwrap()
    .base()
    .clone()
}
fn inspect(raw: &str) -> RecoveryInspection {
    let RecoveryInspectionNeed::Present(row) =
        RecoveryInspection::inspect_data("test-console", raw, "", 0).unwrap()
    else {
        panic!("present data")
    };
    row
}
#[test]
fn actual_old_full_recovery_name_selection_retains_bare_nil_and_last_same_sid() {
    let corpus = corpus();
    let cases = corpus["names"].as_array().unwrap();
    assert_eq!(cases.len(), 8);
    for case in cases {
        let result = RecoveryNames::decode(&base(), case["stdout"].as_str().unwrap());
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(names) = result {
            let entries = names
                .entries()
                .iter()
                .map(|(sid, name)| serde_json::json!([sid.as_str(), name.as_str()]))
                .collect::<Vec<_>>();
            assert_eq!(
                serde_json::json!(entries),
                case["entries"],
                "{}",
                case["name"]
            );
        }
    }
}
#[test]
fn actual_old_optional_inspect_validates_state_and_confirms_complete_absence() {
    let corpus = corpus();
    let cases = corpus["inspection"].as_array().unwrap();
    assert_eq!(cases.len(), 26);
    for case in cases {
        let first = RecoveryInspection::inspect_data(
            "test-console",
            case["stdout"].as_str().unwrap(),
            case["stderr"].as_str().unwrap(),
            u8::try_from(case["code"].as_u64().unwrap()).unwrap(),
        );
        let mut queries = 1;
        let result = first.and_then(|need| match need {
            RecoveryInspectionNeed::Present(row) => Ok(row),
            RecoveryInspectionNeed::ConfirmAbsence => {
                queries += 1;
                RecoveryInspection::confirmed_absence_data(
                    "test-console",
                    case["names"].as_str().unwrap(),
                )
            }
        });
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            queries,
            case["queries"].as_u64().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(row) = result {
            assert_eq!(row.running(), case["running"].as_bool().unwrap());
        }
    }
}
#[test]
fn actual_old_address_keeps_scope_codepoints_before_later_socket_encoding() {
    let corpus = corpus();
    let cases = corpus["address"].as_array().unwrap();
    assert_eq!(cases.len(), 13);
    for case in cases {
        let row = inspect(case["stdout"].as_str().unwrap());
        let result = row.office_address_data();
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["rawCodepoints"]
        );
        if let Ok(value) = result {
            assert_eq!(serde_json::json!(value.codepoints()), case["codepoints"]);
        }
    }
}
#[test]
fn recovery_limits_keep_late_untyped_id_presence_separate_from_inventory_cid() {
    for raw in ["null", "{}", "1", "\"opaque\""] {
        let row = inspect(&format!(
            "[{{\"Id\":{raw},\"State\":{{\"Running\":true}}}}]"
        ));
        assert!(row.assert_native_result_data().is_ok());
    }
    assert!(
        inspect(r#"[{"State":{"Running":true}}]"#)
            .assert_native_result_data()
            .is_err()
    );
}
