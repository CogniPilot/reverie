//! Selected malformed provider data must refuse before the fixed create.
use super::*;

#[test]
fn malformed_native_provider_refuses_before_any_create_or_start() {
    crate::test_process::owning_case!(
        malformed_native_provider_refuses_before_any_create_or_start
    );
    let tree = Tree::new();
    let broker = broker_with_provider(&tree, Some(serde_json::json!({})));
    let (_client, cold) = classified(&broker);
    let result = cold.prepare_cold();
    // Close only the real synthetic Office producer before the verdict. The
    // original launch and storage owner remain retained on either branch.
    match &result {
        Ok(owner) => owner.started.office.close_for_stopped_source(super::super::super::tests::end()).unwrap(),
        Err(owner) => owner.owner.office.as_ref().unwrap().owner()
            .close_for_stopped_source(super::super::super::tests::end()).unwrap(),
    }
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(result.is_err(), "selected malformed provider cannot fall back to legacy");
    assert!(!calls.lines().any(|call| call.starts_with("create\0") || call.starts_with("start\0")));
    assert!(lease_held(&broker));
}
