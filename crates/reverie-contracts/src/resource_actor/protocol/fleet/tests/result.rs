use super::*;

#[test]
fn migration_failure_binds_original_request_and_whole_approval_without_claiming_a_result() {
    let mut value = request();
    value["verb"] = json!("migrate-pool");
    let original = decode(&value).unwrap();
    let frame = original
        .migration_failure("WORKER_POOL_CONTROLLER_CONNECT_DEADLINE")
        .unwrap();
    let wire: Json = serde_json::from_slice(&frame.canonical().unwrap()).unwrap();
    assert_eq!(
        wire,
        json!({
            "kind":"fleet-migration-failure", "purpose":FLEET_MAINTENANCE_PURPOSE,
            "version":1, "requestId":REQUEST, "approval":value["approval"],
            "outcome":"unconfirmed", "code":"WORKER_POOL_CONTROLLER_CONNECT_DEADLINE"
        })
    );
    assert!(decode(&wire).is_err(), "diagnostic DATA is never consent");
    assert!(
        decode(&request())
            .unwrap()
            .migration_failure("FAILED")
            .is_err()
    );
}

#[test]
fn migration_failure_excludes_messages_paths_and_unbounded_diagnostics() {
    let mut value = request();
    value["verb"] = json!("migrate-pool");
    let original = decode(&value).unwrap();
    for bad in [
        "",
        "failed",
        "CODE: /private/config",
        "FAIL\nSECRET",
        "FAIL\0SECRET",
        "ÉRROR",
        &"A".repeat(97),
    ] {
        assert!(
            original.migration_failure(bad).is_err(),
            "unsafe diagnostic"
        );
    }
}
