//! A valid new provider cannot fall back to legacy without a controller.
use super::*;

#[test]
fn legacy_cold_does_not_consult_an_unrelated_busy_controller_slot() {
    crate::test_process::owning_case!(
        legacy_cold_does_not_consult_an_unrelated_busy_controller_slot
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (_client, cold) = classified(&broker);
    let slot = broker.controller.lock().unwrap();
    let result = cold.prepare_cold();
    match &result {
        Ok(owner) => owner
            .started
            .office
            .close_for_stopped_source(super::super::super::tests::end())
            .unwrap(),
        Err(owner) => owner
            .owner
            .office
            .as_ref()
            .unwrap()
            .owner()
            .close_for_stopped_source(super::super::super::tests::end())
            .unwrap(),
    }
    drop(slot);
    assert!(
        result.is_ok(),
        "unselected legacy creation must not consult the native controller slot"
    );
    assert!(tree.root.join("cold-pane-configured").is_file());
    assert!(lease_held(&broker));
}

#[test]
fn selected_native_provider_without_controller_refuses_before_any_create_or_start() {
    crate::test_process::owning_case!(
        selected_native_provider_without_controller_refuses_before_any_create_or_start
    );
    let tree = Tree::new();
    let mut policy = crate::installing_broker::installation_offer::tests::request()
        .policy()
        .clone();
    policy.employee_memory_high_mi_b = std::collections::BTreeMap::from([(EID.into(), 1024)]);
    let broker = broker_with_provider(
        &tree,
        Some(serde_json::json!({
            "version":1,"purpose":"reverie-docker-worker-pool-provider-v1","policy":policy
        })),
    );
    let (_client, inspected) = inspected(&broker);
    let original = inspected
        .observed
        .claimed
        .preparing
        .admitted
        .request
        .connection
        .clone();
    let Err(mut failure) = inspected.classify_existing() else {
        panic!("selected native provider cannot fall back to legacy");
    };
    assert!(matches!(
        &failure.cause,
        PreparationError::Budget(
            crate::installing_broker::creation::CreationBudgetError::Controller(
                reverie_host::worker_pool::PoolError::Refused("WORKER_CONTROLLER_NOT_INSTALLED")
            )
        )
    ));
    assert!(Arc::ptr_eq(
        &original,
        &failure.preparing.admitted.request.connection
    ));
    assert!(
        failure
            .close_transport(super::super::super::tests::end())
            .is_empty()
    );
    assert!(failure.storage.is_some() && failure.active.is_some());
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(
        !calls
            .lines()
            .any(|call| call.starts_with("create\0") || call.starts_with("start\0"))
    );
    assert!(lease_held(&broker));
}
