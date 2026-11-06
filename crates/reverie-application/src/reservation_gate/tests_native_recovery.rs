use super::*;
#[test]
fn cold_recovery_matches_actual_legacy_native_exception_boundaries_without_releasing_claims() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..100 {
        fixture.inventory(&setup.rows);
    }
    gate.reserve(&key(), &request(&setup)).unwrap();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let cases: Value = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/reservation-recovery-native-python.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let mut rows = setup.rows.clone();
        let index = usize::from(case["role"] == "worker");
        mutate(&mut rows[index], case["name"].as_str().unwrap());
        let fixture = Fixture::new();
        fixture.storage_facts(setup.stats);
        for _ in 0..100 {
            fixture.inventory(&rows);
        }
        let gate = setup.tree.gate(&fixture, true);
        let result = gate.cold_inspect();
        match case["outcome"].as_str().unwrap() {
            "propagated" => assert_eq!(
                result.unwrap_err().code(),
                "RESERVATION_NATIVE_STRUCTURE",
                "{case}"
            ),
            expected => {
                let facts = result.unwrap();
                assert!(facts.reservation_retained());
                assert!(!facts.retry_allowed());
                assert_eq!(
                    facts.observations()[0].native,
                    if expected == "matches" {
                        NativeObservationState::Matches
                    } else {
                        NativeObservationState::Unavailable
                    },
                    "{case}"
                );
            }
        }
        assert_eq!(fs::read(&journal).unwrap(), before, "{case}");
        assert!(gate.inner.state.lock().unwrap().active.is_none(), "{case}");
    }
}
fn mutate(row: &mut Value, name: &str) {
    match name {
        "missing-state" => {
            row.as_object_mut().unwrap().remove("State");
        }
        "null-state" => row["State"] = Value::Null,
        "list-state" => row["State"] = json!([]),
        "missing-running" => {
            row["State"].as_object_mut().unwrap().remove("Running");
        }
        "string-running" => row["State"]["Running"] = json!("yes"),
        "missing-host" => {
            row.as_object_mut().unwrap().remove("HostConfig");
        }
        "null-host" => row["HostConfig"] = Value::Null,
        "list-host" => row["HostConfig"] = json!([]),
        "negative-memory" => row["HostConfig"]["Memory"] = json!(-1),
        "missing-pid" => {
            row["State"].as_object_mut().unwrap().remove("Pid");
        }
        "null-pid" => row["State"]["Pid"] = Value::Null,
        "null-config" => row["Config"] = Value::Null,
        "list-config" => row["Config"] = json!([]),
        "list-labels" => row["Config"]["Labels"] = json!(["bad"]),
        "empty-list-labels" => row["Config"]["Labels"] = json!([]),
        field if field.starts_with("missing-") => {
            row["HostConfig"]
                .as_object_mut()
                .unwrap()
                .remove(&field[8..]);
        }
        _ => panic!("unknown frozen legacy mutation: {name}"),
    }
}
