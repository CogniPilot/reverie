use super::*;
use crate::storage_identity::decode_metadata;
use serde_json::json;

const EMPLOYEE: &str = "11111111-2222-4333-8444-555555555555";
const SESSION: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OPERATION: &str = "00000000-0000-0000-0000-000000000000";
const IMAGE: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

#[test]
fn plans_keep_the_legacy_sorted_ascii_digest() {
    let facts = RawValue::from_string(
        r#"{"z":[-0.0,1e-6,18446744073709551616,{"\ud800":"alone","\ud83d\ude00":"astral","\ue000":"bmp"}],"a":"\u007f"}"#.into(),
    )
    .unwrap();
    let expected = "sha256:3cf41d5d268b8916851824862bac202ab61e596b4d409c8f5fbefc644a7db524";
    let bytes = plan(OPERATION, EMPLOYEE, SESSION, IMAGE, &facts).unwrap();
    let text = std::str::from_utf8(bytes.bytes()).unwrap();
    assert!(text.contains(&format!(r#""planDigest":"{expected}""#)));
    assert!(text.contains(r#""a":"\u007f","z":[-0.0,1e-06,18446744073709551616,"#));
}

#[test]
fn capacity_uses_fresh_floors_and_refuses_overflow() {
    let budget = || CapacityBudget {
        full_closure_allocated_bytes: 100,
        overhead_bytes: 5,
        main_floor_bytes: 20,
        scratch_floor_bytes: 10,
    };
    assert_eq!(budget().admit(2, 625, 10).unwrap().gross_model_bytes, 605);
    assert!(budget().admit(2, 624, 10).is_err());
    assert!(budget().admit(2, 625, 9).is_err());
    let overflowing = CapacityBudget {
        full_closure_allocated_bytes: u128::MAX / 2,
        ..budget()
    };
    assert!(overflowing.admit(1, u128::MAX, u128::MAX).is_err());
}

fn cohort_target(employee_digest: &str) -> Target {
    let base = format!("/nix/store/{}-base", "a".repeat(32));
    let target = json!({
        "version": 1, "kind": "reverie.worker-store-target", "imageId": IMAGE,
        "engineId": "fixture", "engineSocket": "/run/docker.sock",
        "validationContainerId": "a".repeat(64), "baseTarget": base,
        "closurePaths": [base], "expiresAtEpoch": 200,
        "cohort": [{
            "employeeId": EMPLOYEE, "employeeDigest": employee_digest,
            "sessionId": SESSION, "sessionGeneration": 1,
        }],
        "budget": {},
        "receipts": {
            "D2": {"path":"/private/d2","digest":IMAGE},
            "CAN":{"path":"/private/can","digest":IMAGE},
        },
    });
    Target::decode(&serde_json::to_vec(&target).unwrap(), 100.0).unwrap()
}

#[test]
fn cohort_checks_exact_records_and_offline_intent() {
    let observed = |vacation: bool| {
        json!({
            "desiredRunning":false, "onVacation":vacation, "id":EMPLOYEE,
            "sessionId":SESSION, "sessionGeneration":1.0, "owner":"Renée",
        })
    };
    let decode =
        |rows| decode_metadata(&serde_json::to_vec(&json!({"employees": rows})).unwrap()).unwrap();
    let pin = |company: &Metadata| {
        let Some(Node::Array(rows)) = field(company.as_value(), "employees").map(|v| &v.0) else {
            panic!("fixture employees");
        };
        cohort_target(&sha(&compact_data(&rows[0])))
    };
    let selected = ProfileEmployeeId::parse(EMPLOYEE).unwrap();
    let offline = decode(vec![observed(true)]);
    let online = decode(vec![observed(false)]);
    let duplicated = decode(vec![observed(true), observed(true)]);
    let target = pin(&offline);
    assert!(
        target
            .admit_cohort(&offline, Some(&selected))
            .unwrap()
            .is_some()
    );
    assert!(target.admit_cohort(&online, None).is_err());
    assert!(target.admit_cohort(&duplicated, None).is_err());
    assert!(pin(&online).admit_cohort(&online, Some(&selected)).is_err());
}
