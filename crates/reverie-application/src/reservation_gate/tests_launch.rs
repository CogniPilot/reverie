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
pub(super) fn source_session(setup: &Setup) -> ProfileSessionId {
    ProfileSessionId::parse(setup.oracle["employee"]["sessionId"].as_str().unwrap()).unwrap()
}
pub(super) fn prepared() -> (Setup, Arc<Fixture>, ReservationGate) {
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
fn ordinary_entry_covers_all_journal_checks_then_restores_original_body_bound() {
    crate::test_process::owning_case!(
        ordinary_entry_covers_all_journal_checks_then_restores_original_body_bound
    );
    for (entry_seconds, operation_seconds) in [(15, None), (15, Some(35)), (35, Some(15))] {
        let (setup, fixture, gate) = prepared();
        let now = Instant::now();
        let entry = now + Duration::from_secs(entry_seconds);
        let operation = operation_seconds.map(|seconds| now + Duration::from_secs(seconds));
        let entered_by = operation.map_or(entry, |operation| entry.min(operation));
        let admission = gate
            .admit_ordinary_launch(
                &source_session(&setup),
                AdmissionBounds {
                    operation,
                    entry: Some(entry),
                },
            )
            .unwrap();
        let entered = fixture.deadlines();
        let entry_ceiling_held = entered.iter().all(|deadline| *deadline <= entered_by);
        let restored_operation = *gate
            .inner
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .deadline
            .lock()
            .unwrap();
        admission
            .check_creation(&policy(BudgetMode::Admission, 512, 4096))
            .unwrap();
        let body = fixture.deadlines();
        let body_bound_held = body[entered.len()..].iter().all(|deadline| {
            operation.is_none_or(|operation| *deadline <= operation)
                && (operation.is_some_and(|operation| operation <= entry) || *deadline > entry)
        });
        admission.close().unwrap();
        assert!(
            entered.len() > 4,
            "journal guards add queries after the initial custody guard"
        );
        assert_eq!(
            restored_operation, operation,
            "restore the ORIGINAL operation bound"
        );
        assert!(
            body_bound_held,
            "entry only bounds re-entry, not the later body"
        );
        assert!(
            entry_ceiling_held,
            "every journal/check_launch observation must remain within the ORIGINAL entry ceiling"
        );
    }
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

#[test]
fn entry_deadline_spans_check_launch_journal_before_becoming_body_deadline() {
    crate::test_process::owning_case!(
        entry_deadline_spans_check_launch_journal_before_becoming_body_deadline
    );
    let (setup, fixture, gate) = prepared();
    let baseline_queries = fixture.deadlines().len();
    let baseline = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let entry_guard_queries = fixture.deadlines().len() - baseline_queries;
    baseline.finish().unwrap();
    assert!(entry_guard_queries > 0);
    let before = fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let observations = observed.clone();
    let weak = Arc::downgrade(&gate.inner);
    let (reached, stage) = std::sync::mpsc::sync_channel(1);
    let (release, wait) = std::sync::mpsc::sync_channel(1);
    let mut queries = 0;
    fixture.on_query(move || {
        let inner = weak.upgrade().unwrap();
        let active = inner.held(None).unwrap();
        observations
            .lock()
            .unwrap()
            .push(*active.deadline.lock().unwrap());
        queries += 1;
        if queries == entry_guard_queries + 1 {
            // The control measured the real generic entry guard above. Its
            // next query belongs to check_launch's actual journal ScopeGuard.
            reached.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        Ok(())
    });
    let entry = Instant::now() + Duration::from_secs(5);
    let controller = std::thread::spawn(move || {
        stage.recv_timeout(Duration::from_secs(10)).unwrap();
        std::thread::sleep(
            entry.saturating_duration_since(Instant::now()) + Duration::from_millis(10),
        );
        release.send(()).unwrap();
    });
    let result = gate.admit_ordinary_launch(
        &source_session(&setup),
        AdmissionBounds {
            operation: None,
            entry: Some(entry),
        },
    );
    let accepted_after_expiry = result.is_ok() && Instant::now() >= entry;
    let outcome = match result {
        Ok(admission) => admission.close(),
        Err(error) => Err(error),
    };
    controller.join().unwrap();
    // Settle the actual admission/flock before any assertion or diagnostic.
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let mut lock = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    lock.close().unwrap();
    assert_eq!(
        fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap(),
        before
    );
    let observations = observed.lock().unwrap();
    assert!(
        observations[..entry_guard_queries]
            .iter()
            .all(|end| *end == Some(entry))
    );
    eprintln!(
        "ordinary-entry witness: entry_queries={entry_guard_queries}, journal_kept_entry={}, accepted_after_expiry={}, outcome={outcome:?}",
        observations[entry_guard_queries] == Some(entry),
        accepted_after_expiry
    );
    assert_eq!(
        observations[entry_guard_queries],
        Some(entry),
        "check_launch's journal phase lost the original entry bound"
    );
    assert!(
        !accepted_after_expiry,
        "ordinary entry succeeded after its original ceiling"
    );
    assert!(
        outcome.is_err(),
        "expiry must refuse entry, not become body time"
    );
}
