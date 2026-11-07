use super::*;

fn candidate(case: &str) -> (Setup, Arc<Fixture>, ReservationGate) {
    let mut setup = Setup::new();
    let mut config: Value = serde_json::from_slice(&setup.tree.raw).unwrap();
    config["budgetMode"] = json!("pool");
    config["memoryMiB"] = json!(1024);
    let own = setup.employee().as_str().to_owned();
    let selected = if case == "unrelated" {
        "77777777-7777-4777-8777-777777777777"
    } else {
        &own
    };
    config["employeeMemoryPolicies"] = if case == "swap-only" {
        json!({selected: {"swapMiB":0}})
    } else {
        json!({selected: {"memoryHighMiB":512,"swapMiB":0}})
    };
    if case == "sid-priority" {
        let sid = source_session(&setup);
        let fields = |memory| json!({"budgetMode":"pool","memoryMiB":memory,"pidsLimit":128,"cpus":0,"poolMemoryMiB":4096,"poolTasksMax":1024});
        config["employeeResources"] = json!({own:fields(2048)});
        config["sessionResources"] = json!({sid.as_str():fields(1024)});
    }
    setup.tree.raw = serde_json::to_vec(&config).unwrap();
    setup.tree.write("worker.json", &setup.tree.raw);
    setup.tree.marker(&config);
    // These are OTHER already-running hard commitments, not a claim that the
    // candidate's desired policy is already enforced on a running leaf.
    setup.rows[1]["Config"]["Labels"] = json!({"reverie.worker":"foreign"});
    setup.rows[1]["Name"] = json!("/foreign-agent");
    let fixture = Fixture::new();
    fixture.protected_pool_facts();
    let gate = setup.gate(&fixture);
    for _ in 0..80 {
        fixture.inventory(&setup.rows);
    }
    (setup, fixture, gate)
}
fn refused(case: &str, memory: u32) {
    let (setup, _, gate) = candidate(case);
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let admission = gate
        .admit_ordinary_launch(&source_session(&setup), AdmissionBounds::default())
        .unwrap();
    let result = admission.check_creation(&policy(BudgetMode::Pool, memory, 4096));
    let accepted = result.is_ok();
    let code = result.as_ref().err().map(GateError::code);
    assert_eq!(
        AdmissionLock::acquire(&gate.inner.config().unwrap())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_ADMISSION_LOCK_BUSY"
    );
    match result {
        Ok(_) => admission.close().unwrap(),
        Err(error) => {
            let _ = admission.fail(error).unwrap_err();
        }
    }
    assert_eq!(fs::read(journal).unwrap(), before);
    assert!(
        !accepted,
        "candidate {case} hardMiB={memory} was accepted without its selected finite soft policy"
    );
    assert_eq!(code, Some("RESERVATION_POOL_CANDIDATE_POLICY"));
}
#[test]
fn pool_zero_hard_candidate_is_refused_under_real_admission() {
    crate::test_process::owning_case!(pool_zero_hard_candidate_is_refused_under_real_admission);
    refused("selected", 0);
}
#[test]
fn pool_swap_only_target_is_refused_under_real_admission() {
    crate::test_process::owning_case!(pool_swap_only_target_is_refused_under_real_admission);
    refused("swap-only", 1024);
}
#[test]
fn pool_unrelated_employee_policy_is_not_candidate_policy() {
    crate::test_process::owning_case!(pool_unrelated_employee_policy_is_not_candidate_policy);
    refused("unrelated", 1024);
}
#[test]
fn pool_candidate_uses_real_sid_override_before_employee_policy() {
    crate::test_process::owning_case!(pool_candidate_uses_real_sid_override_before_employee_policy);
    refused("sid-priority", 2048);
    let (setup, _, gate) = candidate("sid-priority");
    let admission = gate
        .admit_ordinary_launch(&source_session(&setup), AdmissionBounds::default())
        .unwrap();
    let facts = admission
        .check_creation(&policy(BudgetMode::Pool, 1024, 4096))
        .unwrap();
    assert_eq!(facts.committed_bytes, 512 * 1_048_576);
    admission.close().unwrap();
}
