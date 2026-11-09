use super::*;
use crate::reservation_gate::tests::Tree;
use reverie_contracts::reservation_engine::ReservationConfiguration;
use reverie_host::reservation_control::AdmissionLock;
mod fleet_cleanup;
fn name(broker: &InstallingBroker) -> WorkerContainerName {
    WorkerContainerName::for_session(
        broker.configuration().unwrap().envelope().base(),
        &ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap(),
    )
}
fn configured(tree: &Tree) -> InstallingBroker {
    super::prefix_tests::configured::configured(tree)
}
#[test]
fn actual_installed_stop_scope_owns_common_flock_without_launch_image_gpu_or_sid_queries() {
    crate::test_process::owning_case!(
        actual_installed_stop_scope_owns_common_flock_without_launch_image_gpu_or_sid_queries
    );
    let tree = Tree::new();
    let broker = configured(&tree);
    let other_tree = Tree::new();
    let other = configured(&other_tree);
    let scope: WorkerStopAdmission<'_> = broker.admit_ordinary_stop(&name(&broker)).unwrap();
    scope.assert_broker(&broker).unwrap();
    scope.assert_target(&name(&broker)).unwrap();
    let other_name = WorkerContainerName::for_session(
        broker.configuration().unwrap().envelope().base(),
        &ProfileSessionId::parse("99999999-1111-4111-8111-111111111111").unwrap(),
    );
    assert_eq!(
        scope.assert_target(&other_name).unwrap_err().code(),
        "WORKER_STOP_ADMISSION_TARGET"
    );
    assert_eq!(
        scope.assert_broker(&other).unwrap_err().code(),
        "WORKER_STOP_ADMISSION_ORIGIN"
    );
    let config =
        ReservationConfiguration::capture(broker.configuration().unwrap().configuration().clone());
    assert!(AdmissionLock::acquire(&config).is_err());
    let trace = std::fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(
        trace
            .lines()
            .all(|line| line.starts_with("ps\0") || line.starts_with("inspect\0"))
    );
    scope.close().unwrap();
    let mut lock = AdmissionLock::acquire(&config).unwrap();
    lock.close().unwrap();
    broker.close_command_telemetry(super::tests::end()).unwrap();
    other.close_command_telemetry(super::tests::end()).unwrap();
}
#[test]
fn actual_disabled_stop_has_no_fake_gate_and_prior_control_still_refuses() {
    crate::test_process::owning_case!(
        actual_disabled_stop_has_no_fake_gate_and_prior_control_still_refuses
    );
    let tree = Tree::new();
    let broker = super::tests::broker(&tree);
    let scope: WorkerStopAdmission<'_> = broker.admit_ordinary_stop(&name(&broker)).unwrap();
    assert!(broker.resource_reservations().unwrap().is_none());
    scope.abort().unwrap();
    assert!(!tree.root.join("calls.txt").exists());
    tree.write(
        "state/resource-reservation-control.json",
        b"retained prior control",
    );
    assert_eq!(
        broker
            .admit_ordinary_stop(&name(&broker))
            .err()
            .unwrap()
            .code(),
        "RESERVATION_INSTALL_REQUIRES_RECONCILIATION"
    );
    broker.close_command_telemetry(super::tests::end()).unwrap();
}
#[test]
fn actual_stopping_runtime_preserves_original_first_stop_budget_for_scope_and_checked_abort() {
    crate::test_process::owning_case!(
        actual_stopping_runtime_preserves_original_first_stop_budget_for_scope_and_checked_abort
    );
    let tree = Tree::new();
    let broker = configured(&tree);
    broker.storage.runtime.request_stop();
    let original = broker.storage.runtime.stop_deadline();
    let scope: WorkerStopAdmission<'_> = broker.admit_ordinary_stop(&name(&broker)).unwrap();
    let trace = std::fs::read(tree.root.join("calls.txt")).unwrap();
    scope.abort().unwrap();
    assert_eq!(
        std::fs::read(tree.root.join("calls.txt")).unwrap(),
        trace,
        "body failure does not run success-native work"
    );
    assert_eq!(broker.storage.runtime.stop_deadline(), original);
    let config =
        ReservationConfiguration::capture(broker.configuration().unwrap().configuration().clone());
    let mut lock = AdmissionLock::acquire(&config).unwrap();
    lock.close().unwrap();
    broker.close_command_telemetry(super::tests::end()).unwrap();
}
