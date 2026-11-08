//! A valid new provider cannot fall back to legacy without a controller.
use super::*;

#[test]
fn selected_native_provider_without_controller_refuses_before_any_create_or_start() {
    crate::test_process::owning_case!(
        selected_native_provider_without_controller_refuses_before_any_create_or_start
    );
    let tree = Tree::new();
    let mut policy = crate::installing_broker::installation_offer::tests::request().policy().clone();
    policy.employee_memory_high_mi_b = std::collections::BTreeMap::from([(EID.into(),1024)]);
    let broker = broker_with_provider(&tree, Some(serde_json::json!({
        "version":1,"purpose":"reverie-docker-worker-pool-provider-v1","policy":policy
    })));
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
    assert!(result.is_err(), "selected native provider cannot fall back to legacy");
    assert!(!calls.lines().any(|call| call.starts_with("create\0") || call.starts_with("start\0")));
    assert!(lease_held(&broker));
}
