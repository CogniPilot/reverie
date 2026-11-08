use super::*;

#[test]
fn image_maintenance_refuses_predecessor_without_creating_a_service_fence() {
    let (state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    let proof = super::super::stopped::StoppedWorkerService::from_state_for_test(state).unwrap();
    let mut failure = proof.begin_image_transition().err().expect("native installed generation required");
    failure.close_components().unwrap();
    assert!(!root.join("worker-pool/service/pending").exists());
    fs::remove_file(root.join("native-worker-service-bus")).unwrap();
    cleanup_predecessor(root, program);
}

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
    fs::remove_file(root.join("native-worker-service-bus")).unwrap();
    cleanup_predecessor(root, program);
}

#[test]
fn stopped_service_revalidation_refuses_a_reactivated_manager() {
    let (state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    let mut proof = super::super::stopped::StoppedWorkerService::from_state_for_test(state)
        .expect("actual controlled inactive manager");
    fs::write(
        root.join("manager-started"),
        b"concurrent actual manager start",
    )
    .unwrap();
    assert!(proof.revalidate().is_err());
    let mut failure = proof.finish().unwrap_err();
    failure.close_components().unwrap();
    fs::remove_file(root.join("manager-started")).unwrap();
    fs::remove_file(root.join("native-worker-service-bus")).unwrap();
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
    fs::remove_file(root.join("native-worker-service-bus")).unwrap();
    cleanup_predecessor(root, program);
}
