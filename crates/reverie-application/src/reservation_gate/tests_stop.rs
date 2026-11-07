//! Real admission/journal custody with the existing controlled native observer.
//! No container signal, storage release or protected permit is synthesized.
use super::launch_cases::{prepared, source_session};
use super::*;
use reverie_core::{ids::ProfileSessionId, worker_laptop::WorkerContainerName};

fn name(gate: &ReservationGate, session: &ProfileSessionId) -> WorkerContainerName {
    WorkerContainerName::for_session(
        gate.inner.installed.snapshot().unwrap().envelope().base(),
        session,
    )
}

#[test]
fn ordinary_stop_check_keeps_real_admission_and_leaves_empty_journal_unchanged() {
    crate::test_process::owning_case!(
        ordinary_stop_check_keeps_real_admission_and_leaves_empty_journal_unchanged
    );
    let (setup, fixture, gate) = prepared();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let session = source_session(&setup);
    let admission = gate
        .admit_ordinary_launch(&session, AdmissionBounds::default())
        .unwrap();
    let queries = fixture.events().len();
    admission.check_stop(&name(&gate, &session)).unwrap();
    assert!(fixture.events().len() > queries);
    assert_eq!(
        AdmissionLock::acquire(&gate.inner.config().unwrap())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_ADMISSION_LOCK_BUSY"
    );
    assert_eq!(fs::read(&journal).unwrap(), before);
    admission.close().unwrap();
    let mut released = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    released.close().unwrap();
}

#[test]
fn durable_source_reserved_names_and_owned_cid_refuse_without_releasing_claim() {
    crate::test_process::owning_case!(
        durable_source_reserved_names_and_owned_cid_refuse_without_releasing_claim
    );
    let (setup, _, gate) = prepared();
    let reserved = gate.reserve(&key(), &claim_cases::request(&setup)).unwrap();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let source = source_session(&setup);
    let target = ProfileSessionId::parse(reserved.record().data().reserved_sid.as_str()).unwrap();
    let admission = gate
        .admit_ordinary_launch(&source, AdmissionBounds::default())
        .unwrap();
    for session in [&source, &target] {
        assert_eq!(
            admission
                .check_stop(&name(&gate, session))
                .unwrap_err()
                .code(),
            "RESOURCE_OPERATION_STOP_REQUIRES_PROTECTED_RECONCILIATION"
        );
    }
    assert_eq!(
        gate.inner
            .check_ordinary_stop(setup.rows[1]["Id"].as_str().unwrap())
            .unwrap_err()
            .code(),
        "RESOURCE_OPERATION_STOP_REQUIRES_PROTECTED_RECONCILIATION"
    );
    gate.inner
        .check_ordinary_stop(setup.rows[0]["Id"].as_str().unwrap())
        .unwrap();
    let unrelated = ProfileSessionId::parse("99999999-1111-4111-8111-111111111111").unwrap();
    admission.check_stop(&name(&gate, &unrelated)).unwrap();
    assert_eq!(fs::read(&journal).unwrap(), before);
    admission.close().unwrap();
    assert_eq!(fs::read(journal).unwrap(), before);
}

#[test]
fn actual_native_guard_failure_precedes_bad_journal_and_scope_is_always_required() {
    crate::test_process::owning_case!(
        actual_native_guard_failure_precedes_bad_journal_and_scope_is_always_required
    );
    let (setup, fixture, gate) = prepared();
    let session = source_session(&setup);
    let target = name(&gate, &session);
    let admission = gate
        .admit_ordinary_launch(&session, AdmissionBounds::default())
        .unwrap();
    setup
        .tree
        .write("control/operations/operations.json", b"bad journal");
    fixture.on_query(|| Err(ObserverError::Refused("OWNED_FIRST_STOP_GUARD")));
    let error = admission.check_stop(&target).unwrap_err();
    assert_eq!(error.code(), "OWNED_FIRST_STOP_GUARD");
    assert_eq!(
        admission.fail(error).unwrap_err().code(),
        "OWNED_FIRST_STOP_GUARD"
    );
    let queries = fixture.events().len();
    assert_eq!(
        gate.inner
            .check_ordinary_stop(target.as_str())
            .unwrap_err()
            .code(),
        "RESERVATION_ADMISSION_LOCK_REQUIRED"
    );
    assert_eq!(fixture.events().len(), queries);
    assert_eq!(
        fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap(),
        b"bad journal"
    );
}

#[test]
fn unhashable_owned_session_refuses_even_without_active_operations() {
    crate::test_process::owning_case!(
        unhashable_owned_session_refuses_even_without_active_operations
    );
    for value in [json!([]), json!({}), json!([1])] {
        let (setup, fixture, gate) = prepared();
        let session = source_session(&setup);
        let admission = gate
            .admit_ordinary_launch(&session, AdmissionBounds::default())
            .unwrap();
        let mut rows = setup.rows.clone();
        rows[1]["Config"]["Labels"]["reverie.session"] = value;
        fixture.replace_inventory(&rows);
        let result = admission.check_stop(&name(&gate, &session));
        assert!(
            result.is_err(),
            "original set membership must refuse an unhashable session even with empty history"
        );
        admission.fail(result.unwrap_err()).unwrap_err();
    }
}

#[test]
fn another_deployments_unhashable_session_remains_a_nonmatch() {
    crate::test_process::owning_case!(another_deployments_unhashable_session_remains_a_nonmatch);
    let (setup, fixture, gate) = prepared();
    let session = source_session(&setup);
    let admission = gate
        .admit_ordinary_launch(&session, AdmissionBounds::default())
        .unwrap();
    let mut rows = setup.rows.clone();
    rows[1]["Config"]["Labels"]["reverie.worker"] = json!("other-deployment");
    rows[1]["Config"]["Labels"]["reverie.session"] = json!([]);
    fixture.replace_inventory(&rows);
    admission.check_stop(&name(&gate, &session)).unwrap();
    admission.close().unwrap();
}
