//! Actual common flock/canonical journal/native observer; no stop is executed.
use super::launch_cases::{prepared, source_session};
use super::*;
use crate::reservation_gate::OrdinaryStopAdmission;
use reverie_core::worker_laptop::WorkerContainerName;
fn target(
    gate: &ReservationGate,
    session: &reverie_core::ids::ProfileSessionId,
) -> WorkerContainerName {
    WorkerContainerName::for_session(
        gate.inner.installed.snapshot().unwrap().envelope().base(),
        session,
    )
}
fn enter(gate: &ReservationGate, name: &WorkerContainerName) -> Result<OrdinaryStopAdmission> {
    gate.admit_ordinary_stop(&gate.inner.installed, name, None)
}
fn free(gate: &ReservationGate) {
    let mut lock = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    lock.close().unwrap();
}
fn runtime(setup: &Setup, gate: &ReservationGate) -> reverie_host::worker_runtime::WorkerRuntime {
    let snapshot = gate.inner.installed.snapshot().unwrap();
    reverie_host::worker_runtime::WorkerRuntime::new(
        reverie_host::installed_worker_engine::InstalledWorkerEngine::new(
            reverie_host::engine_metadata::EngineBootstrap::from_service(
                crate::test_process::engine_program().as_os_str(),
                std::collections::BTreeMap::new(),
                setup.tree.root.clone(),
            )
            .unwrap(),
        ),
        snapshot.envelope().base(),
    )
}
#[test]
fn actual_stop_entry_matches_generic_guard_then_check_stop_without_launch_sid_phase() {
    crate::test_process::owning_case!(
        actual_stop_entry_matches_generic_guard_then_check_stop_without_launch_sid_phase
    );
    let (_setup, fixture, gate) = prepared();
    let nil =
        reverie_core::ids::ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let name = target(&gate, &nil);
    let before = fixture.events().len();
    let generic = gate.inner.admit(AdmissionBounds::default()).unwrap();
    gate.inner.check_ordinary_stop(name.as_str()).unwrap();
    let reference = fixture.events()[before..].to_vec();
    generic.abort().unwrap();
    let before = fixture.events().len();
    let scope = enter(&gate, &name).unwrap();
    assert_eq!(&fixture.events()[before..], reference);
    assert_eq!(
        AdmissionLock::acquire(&gate.inner.config().unwrap())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_ADMISSION_LOCK_BUSY"
    );
    scope.close().unwrap();
    free(&gate);
}
#[test]
fn actual_stop_source_reserved_and_owned_cid_roles_refuse_and_leave_claim_unchanged() {
    crate::test_process::owning_case!(
        actual_stop_source_reserved_and_owned_cid_roles_refuse_and_leave_claim_unchanged
    );
    let (setup, _, gate) = prepared();
    let reserved = gate.reserve(&key(), &claim_cases::request(&setup)).unwrap();
    let source = source_session(&setup);
    let dest =
        reverie_core::ids::ProfileSessionId::parse(reserved.record().data().reserved_sid.as_str())
            .unwrap();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    for sid in [&source, &dest] {
        let error = enter(&gate, &target(&gate, sid)).err().unwrap();
        assert_eq!(
            error.code(),
            "RESOURCE_OPERATION_STOP_REQUIRES_PROTECTED_RECONCILIATION"
        );
        assert_eq!(fs::read(&journal).unwrap(), before);
        free(&gate);
    }
    let admission = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let error = gate
        .inner
        .check_ordinary_stop(setup.rows[1]["Id"].as_str().unwrap())
        .unwrap_err();
    assert_eq!(
        error.code(),
        "RESOURCE_OPERATION_STOP_REQUIRES_PROTECTED_RECONCILIATION"
    );
    admission.conclude::<()>(Err(error)).unwrap_err();
    assert_eq!(fs::read(journal).unwrap(), before);
    free(&gate);
}
#[test]
fn nested_stop_borrows_exact_outer_admission_and_close_never_closes_or_guards_outer() {
    crate::test_process::owning_case!(
        nested_stop_borrows_exact_outer_admission_and_close_never_closes_or_guards_outer
    );
    let (setup, fixture, gate) = prepared();
    let outer = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let active = gate.inner.held(None).unwrap();
    let scope = enter(&gate, &target(&gate, &source_session(&setup))).unwrap();
    assert!(Arc::ptr_eq(&active, &gate.inner.held(None).unwrap()));
    let before = fixture.events().len();
    scope.close().unwrap();
    assert_eq!(fixture.events().len(), before);
    assert!(Arc::ptr_eq(&gate.inner.held(None).unwrap(), &active));
    assert!(AdmissionLock::acquire(&gate.inner.config().unwrap()).is_err());
    outer.finish().unwrap();
    free(&gate);
}
#[test]
fn stale_borrowed_stop_and_foreign_installed_origin_cannot_close_current_admission() {
    crate::test_process::owning_case!(
        stale_borrowed_stop_and_foreign_installed_origin_cannot_close_current_admission
    );
    let (setup, fixture, gate) = prepared();
    let (_, _, foreign) = prepared();
    let name = target(&gate, &source_session(&setup));
    let before = fixture.events().len();
    assert_eq!(
        gate.admit_ordinary_stop(&foreign.inner.installed, &name, None)
            .err()
            .unwrap()
            .code(),
        "WORKER_STOP_ADMISSION_ORIGIN"
    );
    assert_eq!(fixture.events().len(), before);
    let outer = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let borrowed = enter(&gate, &name).unwrap();
    outer.finish().unwrap();
    let next = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let identity = gate.inner.held(None).unwrap();
    assert_eq!(
        borrowed.close().unwrap_err().code(),
        "RESERVATION_ADMISSION_LOCK_REQUIRED"
    );
    assert!(Arc::ptr_eq(&identity, &gate.inner.held(None).unwrap()));
    assert!(AdmissionLock::acquire(&gate.inner.config().unwrap()).is_err());
    next.abort().unwrap();
    free(&gate);
}
#[test]
fn initial_native_failure_precedes_invalid_journal_and_body_abort_skips_success_guard() {
    crate::test_process::owning_case!(
        initial_native_failure_precedes_invalid_journal_and_body_abort_skips_success_guard
    );
    let (setup, fixture, gate) = prepared();
    let name = target(&gate, &source_session(&setup));
    let original = fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap();
    setup
        .tree
        .write("control/operations/operations.json", b"invalid");
    fixture.on_query(|| Err(ObserverError::Refused("STOP_INITIAL_NATIVE_FAILURE")));
    assert_eq!(
        enter(&gate, &name).err().unwrap().code(),
        "STOP_INITIAL_NATIVE_FAILURE"
    );
    free(&gate);
    fixture.on_query(|| Ok(()));
    setup
        .tree
        .write("control/operations/operations.json", &original);
    let scope = enter(&gate, &name).unwrap();
    let before = fixture.events().len();
    let error = scope
        .fail::<()>(GateError::Refused("ACTUAL_STOP_BODY_FAILURE"))
        .unwrap_err();
    assert_eq!(error.code(), "ACTUAL_STOP_BODY_FAILURE");
    assert_eq!(fixture.events().len(), before);
    free(&gate);
}
#[test]
fn failed_success_guard_still_closes_real_flock_and_poison_preserves_both_causes() {
    crate::test_process::owning_case!(
        failed_success_guard_still_closes_real_flock_and_poison_preserves_both_causes
    );
    let (setup, fixture, gate) = prepared();
    let name = target(&gate, &source_session(&setup));
    let scope = enter(&gate, &name).unwrap();
    fixture.on_query(|| Err(ObserverError::Refused("STOP_FINAL_NATIVE_FAILURE")));
    assert_eq!(
        scope.close().unwrap_err().code(),
        "STOP_FINAL_NATIVE_FAILURE"
    );
    free(&gate);
    fixture.on_query(|| Ok(()));
    let scope = enter(&gate, &name).unwrap();
    let inner = gate.inner.clone();
    assert!(
        std::thread::spawn(move || {
            let _held = inner.state.lock().unwrap();
            panic!("actual state poison");
        })
        .join()
        .is_err()
    );
    let error = scope.close().unwrap_err();
    let GateError::Finalization { primary, secondary } = error else {
        panic!("dual native/local owner failure")
    };
    assert_eq!(primary.code(), "RESERVATION_ADMISSION_UNAVAILABLE");
    assert_eq!(secondary.code(), "RESERVATION_ADMISSION_UNAVAILABLE");
    let state = gate.inner.state.lock().err().unwrap().into_inner();
    assert!(state.active.is_none());
    drop(state);
    let mut lock = AdmissionLock::acquire(&ReservationConfiguration::capture(
        gate.inner
            .installed
            .snapshot()
            .unwrap()
            .configuration()
            .clone(),
    ))
    .unwrap();
    lock.close().unwrap();
}
#[test]
fn stop_native_budget_observes_later_actual_first_stop_for_every_native_call_without_body_reset() {
    crate::test_process::owning_case!(stop_native_budget_observes_later_actual_first_stop_for_every_native_call_without_body_reset);
    let (setup, fixture, gate) = prepared();
    let name = target(&gate, &source_session(&setup));
    // Actual stop producer; this standalone Gate still uses its established
    // controlled native facts. No running workload or source-process grant.
    let snapshot = gate.inner.installed.snapshot().unwrap();
    let runtime = runtime(&setup, &gate);
    let budget = runtime.stop_budget();
    let unbounded_reference = gate
        .inner
        .observer
        .capture(snapshot.configuration().clone(), None);
    let scope = gate
        .admit_ordinary_stop(&gate.inner.installed, &name, Some(&budget))
        .unwrap();
    scope.assert_runtime(&runtime).unwrap();
    assert!(
        gate.inner
            .held(None)
            .unwrap()
            .deadline
            .lock()
            .unwrap()
            .is_none()
    );
    let first = runtime.request_stop();
    // A fresh default30s call after >4s would exceed first-stop+34. Wait on
    // the genuine producer rather than mutating a production/test clock.
    std::thread::sleep(std::time::Duration::from_secs(5));
    assert!(
        unbounded_reference.deadline(None).unwrap() > first,
        "real reference call crossed the original first-stop ceiling"
    );
    let before = fixture.deadlines().len();
    gate.inner.guard(None).unwrap();
    scope.close().unwrap();
    let observed = fixture.deadlines();
    assert!(!observed[before..].is_empty());
    assert!(observed[before..].iter().all(|value| *value <= first));
    assert_eq!(runtime.request_stop(), first);
    free(&gate);
    runtime.close(first).unwrap();
}
#[test]
fn borrowed_stop_cannot_replace_original_active_budget_with_a_different_runtime_view() {
    crate::test_process::owning_case!(
        borrowed_stop_cannot_replace_original_active_budget_with_a_different_runtime_view
    );
    let (setup, fixture, gate) = prepared();
    let name = target(&gate, &source_session(&setup));
    let runtime = runtime(&setup, &gate);
    let foreign = self::runtime(&setup, &gate);
    let budget = runtime.stop_budget();
    let outer = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let scope = gate
        .admit_ordinary_stop(&gate.inner.installed, &name, Some(&budget))
        .unwrap();
    scope.assert_runtime(&runtime).unwrap();
    assert_eq!(
        scope.assert_runtime(&foreign).unwrap_err().code(),
        "WORKER_STOP_ADMISSION_ORIGIN"
    );
    let before = fixture.events().len();
    let error = gate
        .admit_ordinary_stop(&gate.inner.installed, &name, Some(&foreign.stop_budget()))
        .err()
        .unwrap();
    assert_eq!(error.code(), "RESERVATION_STOP_CONTEXT_ORIGIN");
    assert_eq!(fixture.events().len(), before);
    gate.inner
        .held(None)
        .unwrap()
        .context
        .lock()
        .unwrap()
        .inherit_worker_stop_budget(&budget)
        .unwrap();
    scope.close().unwrap();
    outer.finish().unwrap();
    free(&gate);
    runtime
        .close(Instant::now() + std::time::Duration::from_secs(2))
        .unwrap();
    foreign
        .close(Instant::now() + std::time::Duration::from_secs(2))
        .unwrap();
}
