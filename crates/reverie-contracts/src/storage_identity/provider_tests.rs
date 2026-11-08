use super::*;
use serde_json::{Value as Json, json};
fn employee() -> Json {
    json!({"id":"10000000-0000-4000-8000-000000000001","owner":"fixture-owner",
        "sessionId":"10000000-0000-4000-8000-000000000002","sessionGeneration":3,
        "desiredRunning":true,"onVacation":false,"runtimeRecipe":{"mode":"codex"},"permissions":{"recoverEmployees":false}})
}
fn metadata(rows: Json) -> Metadata {
    decode_metadata(&serde_json::to_vec(&json!({"employees":rows})).unwrap()).unwrap()
}
#[test]
fn provider_binding_keeps_the_exact_nine_field_tuple_and_unknown_is_not_running_proof() {
    let row = employee();
    let bindings = metadata(json!([row])).provider_health_bindings().unwrap();
    assert_eq!(bindings.len(), 1);
    assert!(bindings[0].eligible());
    let observed = bindings[0].unknown_observation(1_800_000_000_000).unwrap();
    let observed: Json = serde_json::from_slice(&observed.encode()).unwrap();
    assert_eq!(
        observed,
        json!({"observedBinding":[row["id"],row["owner"],row["sessionId"],row["sessionGeneration"],
        true,false,null,row["runtimeRecipe"],row["permissions"]],"employeeId":row["id"],"sessionId":row["sessionId"],
        "sessionGeneration":3,"state":"unknown","reason":"UNCONFIRMED","observedAtEpochMs":1_800_000_000_000_u64})
    );
    assert!(observed.get("containerId").is_none());
    assert!(observed.get("initPID").is_none());
}
#[test]
fn off_vacation_and_migration_bindings_remain_ineligible_observations() {
    for (field, value) in [
        ("desiredRunning", json!(false)),
        ("onVacation", json!(true)),
        ("bindingMigration", json!({"state":"moving"})),
    ] {
        let mut row = employee();
        row[field] = value;
        let bindings = metadata(json!([row])).provider_health_bindings().unwrap();
        assert!(!bindings[0].eligible(), "{field}");
    }
}
#[test]
fn duplicate_or_noncanonical_provider_bindings_refuse_before_any_process_probe() {
    let row = employee();
    assert!(
        metadata(json!([row.clone(), row.clone()]))
            .provider_health_bindings()
            .is_err()
    );
    for (field, value) in [
        ("sessionGeneration", json!(true)),
        ("sessionGeneration", json!(0)),
        ("sessionGeneration", json!(9_007_199_254_740_992_u64)),
        ("sessionId", json!("foreign")),
    ] {
        let mut changed = row.clone();
        changed[field] = value;
        assert!(
            metadata(json!([changed]))
                .provider_health_bindings()
                .is_err(),
            "{field}"
        );
    }
}
