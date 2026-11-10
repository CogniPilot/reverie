use super::*;
use std::{fs, os::unix::fs::DirBuilderExt};

fn refusal() -> DeploymentError {
    DeploymentError::snapshot(
        "DEPLOYMENT_SNAPSHOT_REFUSED",
        reverie_host::deployment_snapshot::SnapshotError::from(std::io::Error::other(
            "PRIVATE_SNAPSHOT_TOKEN",
        )),
    )
}

#[test]
fn snapshot_refusal_receipt_contains_safe_original_codes_and_never_becomes_success() {
    let operation = fixture_operation();
    let error = operation.record_snapshot_refusal(refusal());
    let receipt = fs::read(operation.directory.join("snapshot-refused.json")).unwrap();
    let value: Value = serde_json::from_slice(&receipt).unwrap();
    fs::remove_dir_all(&operation.directory).unwrap();
    assert_eq!(error.code(), "DEPLOYMENT_SNAPSHOT_REFUSED");
    assert!(error.snapshot_error().is_some());
    assert_eq!(value["operation"], operation.plan.operation);
    assert_eq!(value["phase"], "snapshot-refused");
    assert_eq!(value["data"]["error"]["snapshot"]["code"], "SNAPSHOT_IO");
    assert!(!String::from_utf8(receipt).unwrap().contains("PRIVATE_"));
}

#[test]
fn refusal_receipt_write_error_is_retained_without_replacing_original_receipt_or_cause() {
    let operation = fixture_operation();
    operation
        .record("snapshot-refused", &json!({"preserved":true}))
        .unwrap();
    let path = operation.directory.join("snapshot-refused.json");
    let before = fs::read(&path).unwrap();
    let error = operation.record_snapshot_refusal(refusal());
    let after = fs::read(path).unwrap();
    fs::remove_dir_all(&operation.directory).unwrap();
    assert_eq!(after, before);
    assert_eq!(error.code(), "DEPLOYMENT_SNAPSHOT_REFUSED");
    assert!(error.snapshot_error().is_some());
    assert_eq!(error.finalization_code(), Some("DEPLOYMENT_IO_UNAVAILABLE"));
    assert_eq!(error.finalization_errors().len(), 1);
}

#[test]
fn restored_native_readiness_keeps_original_id_and_native_mode() {
    let old = "a".repeat(64);
    let next = "b".repeat(64);
    let mut operation = fixture_operation();
    let directory = operation.directory.clone();
    operation.record("candidate", &json!({"id":next})).unwrap();
    let restored = operation.readiness_target(false).unwrap();
    let candidate = operation.readiness_target(true).unwrap();
    operation.plan.source["Config"]["Env"] = json!([]);
    let legacy = operation.readiness_target(false).unwrap();
    operation.plan.source["Config"]["Env"] = json!(["REVERIE_NATIVE_FRONT=0"]);
    let invalid = operation.readiness_target(false);
    fs::remove_dir_all(directory).unwrap();
    assert_eq!(restored, (old.clone(), true));
    assert_eq!(candidate, (next, true));
    assert_eq!(legacy, (old, false));
    assert!(invalid.is_err());
}

fn fixture_operation() -> Operation {
    let mut random = [0_u8; 16];
    getrandom::getrandom(&mut random).unwrap();
    let suffix = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let directory = std::env::temp_dir().join(format!("deployment-target-{suffix}"));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    let old = "a".repeat(64);
    Operation {
        directory: directory.clone(),
        plan: Plan {
            version: 1,
            operation: "c".repeat(32),
            container: "fixture".into(),
            installation_revision: "fixture".into(),
            source: json!({"Id":old,"Config":{"Env":["REVERIE_NATIVE_FRONT=1"]}}),
            body: Value::Null,
            preview: DeploymentPreview {
                operation: "c".repeat(32),
                container: "fixture".into(),
                source_id: old.clone(),
                source_image: "old".into(),
                candidate_image: "next".into(),
                environment_policy: "fixture".into(),
                refreshed_environment_keys: Vec::new(),
                broker_preserved: true,
                backup_metadata_scope: "fixture".into(),
                profile: None,
            },
            bind_identities: Vec::new(),
        },
    }
}
