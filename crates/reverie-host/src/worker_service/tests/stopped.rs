use super::*;

#[test]
fn stopped_service_receipt_requires_the_same_original_inactive_generation() {
    let (state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    let mut proof = super::super::stopped::StoppedWorkerService::from_state_for_test(state)
        .expect("actual controlled inactive manager");
    let origin = proof.origin();
    assert_eq!(proof.source(), root.join("worker.json"));
    proof.revalidate().unwrap();
    let closed = proof.finish().unwrap();
    assert!(closed.belongs_to(&origin));
    assert_eq!(closed.source(), root.join("worker.json"));
    assert!(!root.join("manager-stops").exists());
    assert!(!root.join("manager-started").exists());
    cleanup_predecessor(root, program);
}

#[test]
fn stopped_service_revalidation_refuses_a_reactivated_manager() {
    let (state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    let mut proof = super::super::stopped::StoppedWorkerService::from_state_for_test(state)
        .expect("actual controlled inactive manager");
    fs::write(root.join("manager-started"), b"concurrent actual manager start").unwrap();
    assert!(proof.revalidate().is_err());
    let mut failure = proof.finish().unwrap_err();
    failure.close_components().unwrap();
    fs::remove_file(root.join("manager-started")).unwrap();
    cleanup_predecessor(root, program);
}

#[test]
fn stopped_service_close_failure_is_sticky_on_the_same_original_owner() {
    let (state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    let proof = super::super::stopped::StoppedWorkerService::from_state_for_test(state)
        .expect("actual controlled inactive manager");
    native::test_faults::set(None, true);
    let mut failure = proof.finish().unwrap_err();
    assert!(failure.close_components().is_err());
    drop(failure);
    cleanup_predecessor(root, program);
}
