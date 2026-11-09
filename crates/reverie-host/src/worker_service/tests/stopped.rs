use super::*;
mod image_cas;
use std::os::unix::fs::PermissionsExt;

fn native_image_fixture() -> (super::super::StoppedWorkerService, PathBuf, PathBuf) {
    let (mut state, root, program) = fixture_mode("native-worker-manager-rollback");
    state.root = root.join("reverie");
    state.source = state.root.join("worker.json");
    prepare_predecessor(&state);
    let link = root.join(".config/systemd/user").join(UNIT);
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&state.unit, &link).unwrap();
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state.folder())
        .unwrap();
    let environment_file = state.folder().join("environment");
    fs::write(&environment_file, environment(&state.source).unwrap()).unwrap();
    fs::set_permissions(environment_file, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&state.source, b"{}").unwrap();
    fs::set_permissions(&state.source, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(
        root.join("manager-native-mode"),
        b"current native generation",
    )
    .unwrap();
    let proof = super::super::StoppedWorkerService::from_state_for_test(state).unwrap();
    (proof, root, program)
}
fn cleanup_native_image(root: PathBuf, program: PathBuf) {
    fs::remove_file(root.join("native-worker-service-bus")).unwrap();
    fs::remove_file(root.join("manager-native-mode")).unwrap();
    fs::remove_file(root.join("reverie/worker.json")).unwrap();
    fs::remove_file(root.join("reverie/worker-pool/service/environment")).unwrap();
    fs::remove_dir(root.join("reverie/worker-pool/service")).unwrap();
    fs::remove_dir(root.join("reverie/worker-pool")).unwrap();
    fs::remove_dir(root.join("reverie")).unwrap();
    cleanup_predecessor(root, program);
}

#[test]
fn actual_native_image_guard_blocks_startup_until_outer_release_after_close() {
    let (proof, root, program) = native_image_fixture();
    let origin = proof.origin();
    let mut guard = proof.begin_image_transition().unwrap();
    let pending = root.join("reverie/worker-pool/service/pending");
    assert_eq!(
        fs::read(&pending).unwrap(),
        super::super::stopped::IMAGE_PENDING
    );
    assert!(super::super::failure_fence::assert_pending_permits_startup(&pending).is_err());
    guard.revalidate().unwrap();
    let closed = guard.close().unwrap();
    assert!(pending.is_file());
    assert!(closed.belongs_to(&origin));
    let released = closed.release().unwrap();
    assert!(released.belongs_to(&origin));
    assert!(!pending.exists());
    cleanup_native_image(root, program);
}

#[test]
fn actual_native_image_guard_keeps_outer_fence_after_consumed_close_failure() {
    let (proof, root, program) = native_image_fixture();
    let guard = proof.begin_image_transition().unwrap();
    native::test_faults::set(None, true);
    let mut failure = guard
        .close()
        .err()
        .expect("original consumed close must remain uncertain");
    assert!(failure.close_components().is_err());
    let pending = root.join("reverie/worker-pool/service/pending");
    assert!(pending.is_file());
    drop(failure);
    fs::remove_file(pending).unwrap();
    cleanup_native_image(root, program);
}

#[test]
fn image_maintenance_refuses_predecessor_without_creating_a_service_fence() {
    let (state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    let proof = super::super::stopped::StoppedWorkerService::from_state_for_test(state).unwrap();
    let mut failure = proof
        .begin_image_transition()
        .err()
        .expect("native installed generation required");
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
