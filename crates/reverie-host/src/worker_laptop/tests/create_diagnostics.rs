//! Historical DATA reads use the original bounded runtime owners only.
use super::*;
use crate::command_telemetry::CommandTelemetry;

#[test]
fn original_runtime_lists_same_nonzero_create_without_queries_replay_or_foreign_results() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::create_diagnostics::original_runtime_lists_same_nonzero_create_without_queries_replay_or_foreign_results",
    ) {
        return;
    }
    let fixture = Fixture::new("created-nonzero-output");
    let other = Fixture::new("created-normal");
    assert!(
        fixture
            .runtime()
            .completed_create_diagnostics()
            .unwrap()
            .is_empty()
    );
    let workflow = fixture.retain();
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .create_laptop(&workflow, &telemetry, end())
            .unwrap(),
        LaptopCreation::Retained
    ));
    let original = workflow.completed_create_diagnostic().unwrap().unwrap();
    let before = fs::read(fixture.root.join("trace")).unwrap();
    let listed = fixture.runtime().completed_create_diagnostics().unwrap();
    let registry_contention = {
        let _held = fixture.runtime().laptop_workflows().records.lock().unwrap();
        fixture.runtime().completed_create_diagnostics().is_err()
    };
    let record_contention = {
        let _held = workflow.record.lock().unwrap();
        fixture.runtime().completed_create_diagnostics().is_err()
    };
    let foreign_empty = other
        .runtime()
        .completed_create_diagnostics()
        .unwrap()
        .is_empty();
    let repeated = fixture.runtime().completed_create_diagnostics().unwrap();
    let unchanged = fs::read(fixture.root.join("trace")).unwrap() == before;
    let retained = {
        let record = workflow.record.lock().unwrap();
        record.unknown && record.phase == Phase::Retained
    };
    // Preserve the actual failed resource/Office/lease owner before verdict;
    // this does not invent a successful Runtime or employee cleanup receipt.
    fixture.retain_after_expired_stop();
    drop(other);
    assert_eq!(listed.len(), 1);
    assert_eq!(repeated.len(), 1);
    assert!(Arc::ptr_eq(&listed[0], &original));
    assert!(Arc::ptr_eq(&repeated[0], &original));
    assert_eq!(
        listed[0].stderr(),
        b"create rejected: fixture mount absent\n"
    );
    assert!(registry_contention && record_contention);
    assert!(foreign_empty && unchanged && retained);
}
