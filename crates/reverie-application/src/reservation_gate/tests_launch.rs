use super::*;
use reverie_core::{
    ids::ProfileSessionId,
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
};

fn policy(mode: BudgetMode, memory: u32, pool: u32) -> ResourcePolicy {
    ResourcePolicy::try_new(
        mode,
        memory,
        128,
        CpuQuota::from_integer(0).unwrap(),
        pool,
        1024,
    )
    .unwrap()
}
fn source_session(setup: &Setup) -> ProfileSessionId {
    ProfileSessionId::parse(setup.oracle["employee"]["sessionId"].as_str().unwrap()).unwrap()
}
fn prepared() -> (Setup, Arc<Fixture>, ReservationGate) {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..180 {
        fixture.inventory(&setup.rows);
    }
    (setup, fixture, gate)
}

#[test]
fn ordinary_launch_retains_real_admission_through_capacity_and_checked_close() {
    crate::test_process::owning_case!(
        ordinary_launch_retains_real_admission_through_capacity_and_checked_close
    );
    let (setup, fixture, gate) = prepared();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let session = source_session(&setup);
    let admission = gate
        .admit_ordinary_launch(&session, AdmissionBounds::default())
        .unwrap();
    assert_eq!(admission.session(), &session);
    assert_eq!(
        AdmissionLock::acquire(&gate.inner.config().unwrap())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_ADMISSION_LOCK_BUSY"
    );
    let queried = fixture.events().len();
    assert_eq!(
        gate.admit_ordinary_launch(&session, AdmissionBounds::default())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_REENTRANT_ADMISSION"
    );
    assert_eq!(fixture.events().len(), queried);
    let facts = admission
        .check_creation(&policy(BudgetMode::Admission, 512, 4096))
        .unwrap();
    assert_eq!(facts.committed_bytes, 512 * 1_048_576);
    assert_eq!(facts.retained_bytes, 0);
    assert!(facts.budget_bytes >= facts.committed_bytes + 512 * 1_048_576);
    assert!(gate.inner.state.lock().unwrap().active.is_some());
    admission.close().unwrap();
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let mut lock = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    lock.close().unwrap();
    assert_eq!(fs::read(journal).unwrap(), before);
}

#[test]
fn ordinary_launch_rejects_nil_after_real_entry_without_leaking_admission() {
    crate::test_process::owning_case!(
        ordinary_launch_rejects_nil_after_real_entry_without_leaking_admission
    );
    let (_setup, fixture, gate) = prepared();
    let nil = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let error = gate
        .admit_ordinary_launch(&nil, AdmissionBounds::default())
        .err()
        .unwrap();
    assert!(matches!(error, GateError::Operation(_)), "{error:?}");
    assert!(
        !fixture.events().is_empty(),
        "entry guards precede check_launch"
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let mut lock = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    lock.close().unwrap();
}

#[test]
fn ordinary_launch_refuses_real_durable_reserved_target_without_releasing_claim() {
    crate::test_process::owning_case!(
        ordinary_launch_refuses_real_durable_reserved_target_without_releasing_claim
    );
    let (setup, _, gate) = prepared();
    let reserved = gate.reserve(&key(), &claim_cases::request(&setup)).unwrap();
    let sid = ProfileSessionId::parse(reserved.record().data().reserved_sid.as_str()).unwrap();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    assert_eq!(
        gate.admit_ordinary_launch(&sid, AdmissionBounds::default())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_RESERVATION_REQUIRES_PROTECTED_RECONCILIATION"
    );
    assert_eq!(fs::read(journal).unwrap(), before);
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}

#[test]
fn creation_host_job_failure_precedes_policy_and_skips_success_native_guard() {
    crate::test_process::owning_case!(
        creation_host_job_failure_precedes_policy_and_skips_success_native_guard
    );
    let (setup, fixture, gate) = prepared();
    let admission = gate
        .admit_ordinary_launch(&source_session(&setup), AdmissionBounds::default())
        .unwrap();
    setup
        .tree
        .write("control/operations/host-job.finish.pending.json", b"{}");
    let queried = fixture.events().len();
    let error = admission
        .check_creation(&policy(BudgetMode::Pool, 512, 8192))
        .unwrap_err();
    assert_eq!(error.code(), "HOST_JOB_FINISH_REQUIRES_RECONCILIATION");
    assert_eq!(fixture.events().len(), queried);
    assert_eq!(
        admission.fail(error).unwrap_err().code(),
        "HOST_JOB_FINISH_REQUIRES_RECONCILIATION"
    );
    assert_eq!(fixture.events().len(), queried);
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}

#[test]
fn creation_requires_exact_admission_pool_before_capacity_queries() {
    crate::test_process::owning_case!(
        creation_requires_exact_admission_pool_before_capacity_queries
    );
    let (setup, fixture, gate) = prepared();
    let admission = gate
        .admit_ordinary_launch(&source_session(&setup), AdmissionBounds::default())
        .unwrap();
    for resources in [
        policy(BudgetMode::Pool, 512, 4096),
        policy(BudgetMode::Admission, 512, 8192),
    ] {
        let before = fixture
            .events()
            .iter()
            .filter(|event| event.starts_with("limits:"))
            .count();
        assert_eq!(
            admission.check_creation(&resources).unwrap_err().code(),
            "RESERVATION_ADMISSION_POLICY_REQUIRED"
        );
        assert_eq!(
            fixture
                .events()
                .iter()
                .filter(|event| event.starts_with("limits:"))
                .count(),
            before
        );
    }
    admission.close().unwrap();
}

#[test]
fn exhausted_creation_retains_scope_and_body_failure_preserves_journal() {
    crate::test_process::owning_case!(
        exhausted_creation_retains_scope_and_body_failure_preserves_journal
    );
    let (setup, fixture, gate) = prepared();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let admission = gate
        .admit_ordinary_launch(&source_session(&setup), AdmissionBounds::default())
        .unwrap();
    let error = admission
        .check_creation(&policy(BudgetMode::Admission, 4096, 4096))
        .unwrap_err();
    assert_eq!(error.code(), "RESERVATION_CAPACITY_EXHAUSTED");
    assert!(gate.inner.state.lock().unwrap().active.is_some());
    let queried = fixture.events().len();
    assert_eq!(
        admission.fail(error).unwrap_err().code(),
        "RESERVATION_CAPACITY_EXHAUSTED"
    );
    assert_eq!(fixture.events().len(), queried);
    assert_eq!(fs::read(journal).unwrap(), before);
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}

#[test]
fn creation_counts_retained_real_claim_at_exact_candidate_boundary() {
    crate::test_process::owning_case!(
        creation_counts_retained_real_claim_at_exact_candidate_boundary
    );
    let (setup, _, gate) = prepared();
    gate.reserve(&key(), &claim_cases::request(&setup)).unwrap();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let admission = gate
        .admit_ordinary_launch(&source_session(&setup), AdmissionBounds::default())
        .unwrap();
    let facts = admission
        .check_creation(&policy(BudgetMode::Admission, 3072, 4096))
        .unwrap();
    assert_eq!(facts.retained_bytes, 512 * 1_048_576);
    assert_eq!(facts.committed_bytes, 512 * 1_048_576);
    assert_eq!(facts.budget_bytes, 4096 * 1_048_576);
    assert_eq!(
        admission
            .check_creation(&policy(BudgetMode::Admission, 3073, 4096))
            .unwrap_err()
            .code(),
        "RESERVATION_CAPACITY_EXHAUSTED"
    );
    admission.close().unwrap();
    assert_eq!(fs::read(journal).unwrap(), before);
}

#[test]
fn checked_close_reports_lost_native_observation_and_still_consumes_owned_lock() {
    crate::test_process::owning_case!(
        checked_close_reports_lost_native_observation_and_still_consumes_owned_lock
    );
    let (setup, fixture, gate) = prepared();
    let admission = gate
        .admit_ordinary_launch(&source_session(&setup), AdmissionBounds::default())
        .unwrap();
    fixture.on_query(|| Err(ObserverError::Refused("OWNED_CLOSE_OBSERVATION_FAILED")));
    assert_eq!(
        admission.close().unwrap_err().code(),
        "OWNED_CLOSE_OBSERVATION_FAILED"
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let mut lock = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    lock.close().unwrap();
}

#[test]
fn actual_python_ordinary_creation_vectors_match_real_journal_and_held_scope() {
    crate::test_process::owning_case!(
        actual_python_ordinary_creation_vectors_match_real_journal_and_held_scope
    );
    let oracle: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/ordinary-launch-python.json"
    ))
    .unwrap();
    for case in oracle["cases"].as_array().unwrap() {
        let (setup, _, gate) = prepared();
        let reserved = case["reserved"].as_bool().unwrap();
        let mut sid = source_session(&setup);
        if reserved || case["retainedMiB"] == json!(512) {
            let view = gate.reserve(&key(), &claim_cases::request(&setup)).unwrap();
            if reserved {
                sid = ProfileSessionId::parse(view.record().data().reserved_sid.as_str()).unwrap();
            }
        }
        if case["nil"].as_bool().unwrap() {
            sid = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
        }
        let result = match gate.admit_ordinary_launch(&sid, AdmissionBounds::default()) {
            Ok(admission) => {
                if case["pending"].as_bool().unwrap() {
                    setup
                        .tree
                        .write("control/operations/host-job.finish.pending.json", b"{}");
                }
                let resources = policy(
                    if case["mode"] == "admission" {
                        BudgetMode::Admission
                    } else {
                        BudgetMode::Pool
                    },
                    u32::try_from(case["memoryMiB"].as_u64().unwrap()).unwrap(),
                    u32::try_from(case["poolMemoryMiB"].as_u64().unwrap()).unwrap(),
                );
                match admission.check_creation(&resources) {
                    Ok(_) => admission.close(),
                    Err(error) => admission.fail(error),
                }
            }
            Err(error) => Err(error),
        };
        assert_eq!(
            result.err().map(|error| error.code()),
            case["error"].as_str(),
            "{}",
            case["name"]
        );
        assert!(gate.inner.state.lock().unwrap().active.is_none());
    }
}
