use super::*;
use reverie_contracts::storage_identity::decode_metadata;
#[test]
fn storage_status_preserves_original_lease_and_never_invents_owner_generation() {
    crate::test_process::owning_case!(
        storage_status_preserves_original_lease_and_never_invents_owner_generation
    );
    let tree = Tree::new();
    let registry = tree.registry();
    let source = tree.source();
    let claim = registry.claim(&source, &sid(SID)).unwrap();
    let company = decode_metadata(&fs::read(tree.0.join("company.json")).unwrap()).unwrap();
    let before = tree.calls();
    let rows = registry.storage_status(&company).unwrap();
    let value = serde_json::to_value(&rows).unwrap();
    let same_snapshot = registry.storage_status(&company).unwrap();
    let no_effect = tree.calls() == before;
    let lease_held = StorageLease::acquire_launch(&source, &sid(SID)).is_err();
    let count = registry.entries.lock().unwrap().len();
    let locked = registry.entries.lock().unwrap();
    let refusal = registry
        .storage_status(&company)
        .err()
        .unwrap()
        .code()
        .to_owned();
    drop(locked);
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    assert_eq!(count, 1);
    assert!(lease_held && no_effect);
    assert_eq!(rows, same_snapshot);
    assert_eq!(refusal, "STORAGE_STATUS_LOCK_UNAVAILABLE");
    assert_eq!(
        value,
        json!([{"sessionId":SID,"currentSessionGeneration":null,
        "writerChecked":true,"ownerKind":"direct","observation":{
            "state":"observed","phase":"held","finalStorageCheck":null,
            "outcome":"not-recorded","nativePending":null,"nativeUncertain":null
        }}])
    );
    assert!(
        !serde_json::to_string(&value)
            .unwrap()
            .contains(tree.0.to_str().unwrap())
    );
}

#[test]
fn storage_status_labels_current_generation_and_binding_drift_as_data_only() {
    crate::test_process::owning_case!(
        storage_status_labels_current_generation_and_binding_drift_as_data_only
    );
    let tree = Tree::new();
    let registry = tree.registry();
    let source = tree.source();
    let claim = registry.claim(&source, &sid(SID)).unwrap();
    let company = |generation, session| {
        decode_metadata(
            &serde_json::to_vec(&json!({"employees":[{
                "id":EID,"sessionId":session,"owner":null,"sessionGeneration":generation
            }]}))
            .unwrap(),
        )
        .unwrap()
    };
    let rows = registry.storage_status(&company(7, SID)).unwrap();
    let drift = registry.storage_status(&company(8, NEXT_SID)).unwrap();
    let calls = tree.calls();
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    assert_eq!(rows[0].current_session_generation.as_deref(), Some("7"));
    assert_eq!(drift[0].current_session_generation, None);
    assert_eq!(rows[0].session_id, SID);
    assert_eq!(tree.calls(), calls);
}
