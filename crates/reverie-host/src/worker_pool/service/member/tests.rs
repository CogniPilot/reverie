//! Metadata-only sequence tests. These own no installed pool or controller
//! peer, and do not claim that native cgroup effects have executed.
use super::*;
use crate::worker_pool::member_policy::MemberPolicies;

const EMPLOYEE: &str = "22222222-2222-4222-8222-222222222222";

fn policy() -> WorkerPoolPolicy {
    WorkerPoolPolicy::decode(
        &serde_json::to_vec(&serde_json::json!({
            "version":1, "purpose":reverie_contracts::worker_pool::PURPOSE,
            "deployment":"fixture", "instanceRoot":"/home/fixture/reverie",
            "engineId":"11111111-1111-4111-8111-111111111111",
            "anchorImage":format!("sha256:{}", "a".repeat(64)),
            "controllerImage":format!("sha256:{}", "b".repeat(64)),
            "websiteContainer":"c".repeat(64), "brokerUid":1000, "brokerGid":1000,
            "memoryMaxMiB":reverie_contracts::worker_pool::MEMORY_MAX_MIB,
            "poolTasksMax":reverie_contracts::worker_pool::TASKS_MAX,
            "cpuWeight":100, "allowedCpus":[0],
            "employeeMemoryHighMiB":{(EMPLOYEE):512}
        }))
        .unwrap(),
    )
    .unwrap()
}

fn state() -> State {
    State {
        stage: InstallationStage::Opening,
        directory: None,
        anchor: anchor::Anchor::default(),
        member_failure: None,
        member_attempted: Vec::new(),
        member_policies: MemberPolicies::default(),
        member_policy_revision: 0,
        restored_birth: None,
        edit: None,
        primary: None,
    }
}

fn future() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

fn record_refusal(state: &mut State, refusal: MemberRequestRefusal) -> MemberRequestRefusal {
    state
        .record_request_error(PoolError::MemberRequestRefused(refusal))
        .unwrap()
}

#[test]
fn full_attempt_registry_preserves_observe_and_edit_preflight_after_extra_refusal() {
    let mut state = state();
    let policy = policy();
    for index in 0..256 {
        let cid = format!("{index:064x}");
        state
            .prepare_member(&policy, EMPLOYEE, &cid, true, future())
            .unwrap();
        // Seed completed admission history DATA; no real native CID is owned
        // or released by this test.
        state.member_attempted.push(cid);
    }
    let previous = state.member_attempted.clone();
    let next = format!("{:064x}", 256);
    let refusal = state
        .prepare_member(&policy, EMPLOYEE, &next, true, future())
        .unwrap_err();
    let refusal = record_refusal(&mut state, refusal);
    assert_eq!(refusal.code(), "WORKER_POOL_MEMBER_CAPACITY_EXHAUSTED");
    assert_eq!(state.member_attempted, previous);
    assert!(state.primary_error().is_none());
    assert!(state.member_failure.is_none() && state.edit.is_none());
    assert_eq!(state.member_policy_revision, 0);
    let before = state
        .prepare_member(&policy, EMPLOYEE, &previous[0], false, future())
        .unwrap();
    assert_eq!(before.memory_high_mib(), 512);
    let edit = protocol::MemberPolicyEdit {
        operation: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
        employee: EMPLOYEE.into(),
        session: "33333333-3333-4333-8333-333333333333".into(),
        container: previous[0].clone(),
        pid: 7,
        start: "100".into(),
        leaf: (7, 8),
        before,
        proposed: WorkerPoolMemberPolicy::new(768, 200).unwrap(),
        expected_revision: 0,
    };
    super::super::member_policy::check_candidate(
        &policy,
        &state.member_policies,
        state.member_policy_revision,
        &edit,
        future(),
    )
    .unwrap();
    assert!(state.primary_error().is_none());
}

#[test]
fn invalid_policy_duplicate_and_expired_requests_preserve_attempt_history() {
    let mut state = state();
    let policy = policy();
    let cid = "d".repeat(64);
    let invalid = state
        .prepare_member(
            &policy,
            "33333333-3333-4333-8333-333333333333",
            &cid,
            true,
            future(),
        )
        .unwrap_err();
    assert_eq!(
        record_refusal(&mut state, invalid).code(),
        "WORKER_POOL_MEMBER_POLICY"
    );
    assert!(state.member_attempted.is_empty());
    let expired = state
        .prepare_member(&policy, EMPLOYEE, &cid, true, Instant::now())
        .unwrap_err();
    assert_eq!(
        record_refusal(&mut state, expired).code(),
        "WORKER_POOL_ACTIVATION_DEADLINE"
    );
    assert!(state.member_attempted.is_empty());
    state.member_attempted.push(cid.clone());
    let duplicate = state
        .prepare_member(&policy, EMPLOYEE, &cid, true, future())
        .unwrap_err();
    assert_eq!(
        record_refusal(&mut state, duplicate).code(),
        "WORKER_POOL_MEMBER_ALREADY_ATTEMPTED"
    );
    assert_eq!(state.member_attempted, [cid]);
    assert!(state.primary_error().is_none());
}

#[test]
fn diagnostic_lookalikes_and_unknown_native_close_remain_retained() {
    for error in [
        PoolError::Refused("WORKER_POOL_MEMBER_CAPACITY_EXHAUSTED"),
        PoolError::MetadataClose(Box::new(PoolError::Io(std::io::Error::other(
            "checked close",
        )))),
    ] {
        let mut state = state();
        assert!(state.record_request_error(error).is_none());
        assert!(state.primary_error().is_some());
        let previous = state.primary_error().unwrap().code();
        assert!(
            state
                .record_request_error(PoolError::MemberRequestRefused(
                    MemberRequestRefusal::capacity()
                ))
                .is_none()
        );
        assert_eq!(state.primary_error().unwrap().code(), previous);
    }
}
