//! Original native query custody and DATA checks, not an OS/pool grant.
use super::{PoolTargetObservation, PoolTargetObservationError, PoolTargetPhase, WorkerPoolPolicy};
use crate::{engine_metadata::EngineFault, worker_runtime::WorkerRuntime};
use std::{
    fs,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
mod fixture;
use fixture::*;

#[test]
fn same_runtime_reads_fixed_daemon_and_each_exact_image_before_reobservation() {
    let fixture = Fixture::new();
    let mut owner =
        PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, end()).unwrap();
    assert_eq!(owner.phase(), PoolTargetPhase::Captured);
    let first = owner.observe(&fixture.runtime, &fixture.policy);
    let first_phase = owner.phase();
    let observed_policy = owner.policy_data().clone();
    let second = owner.observe(&fixture.runtime, &fixture.policy);
    let trace = fs::read_to_string(fixture.root.join("target-calls.txt"));
    let starts = fixture.starts();
    let closed = owner.close(&fixture.runtime);
    let phase = owner.phase();
    let after_close = owner.observe(&fixture.runtime, &fixture.policy);
    fixture.finish();
    first.unwrap();
    second.unwrap();
    closed.unwrap();
    assert_eq!(first_phase, PoolTargetPhase::Observed);
    assert_eq!(phase, PoolTargetPhase::Closed);
    assert!(after_close.is_err());
    assert_eq!(observed_policy.anchor_image, image('a'));
    assert_eq!(starts, 6);
    let lines = trace
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 6);
    assert!(lines[0].starts_with("info\0--format\0"));
    assert_eq!(
        lines[1],
        format!("image\0inspect\0--format\0{{{{json .}}}}\0{}", image('a'))
    );
    assert_eq!(
        lines[2],
        format!("image\0inspect\0--format\0{{{{json .}}}}\0{}", image('b'))
    );
    assert_eq!(&lines[..3], &lines[3..]);
}

#[test]
fn daemon_and_both_image_schema_failures_keep_first_cause_and_block_another_round() {
    for (file, field, invalid, expected_reads) in [
        ("info", "ID", serde_json::json!("foreign"), 1),
        ("info", "CgroupDriver", serde_json::json!("cgroupfs"), 1),
        ("info", "CgroupVersion", serde_json::json!("1"), 1),
        (
            "info",
            "SecurityOptions",
            serde_json::json!(["name=rootless"]),
            1,
        ),
        ("info", "SecurityOptions", serde_json::Value::Null, 1),
        ("anchor", "Id", serde_json::json!(image('b')), 2),
        ("anchor", "Os", serde_json::json!("windows"), 2),
        ("anchor", "Config", serde_json::Value::Null, 2),
        ("controller", "Id", serde_json::json!(image('a')), 3),
        ("controller", "Os", serde_json::json!("windows"), 3),
        ("controller", "Config", serde_json::json!([]), 3),
    ] {
        let fixture = Fixture::new();
        let mut raw: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.root.join(format!("{file}.json"))).unwrap())
                .unwrap();
        raw[field] = invalid;
        fixture.write(file, raw);
        let mut owner =
            PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, end()).unwrap();
        let first = owner
            .observe(&fixture.runtime, &fixture.policy)
            .unwrap_err();
        let repeated = owner
            .observe(&fixture.runtime, &fixture.policy)
            .unwrap_err();
        let phase = owner.phase();
        let starts = fixture.starts();
        let closed = owner.close(&fixture.runtime);
        fixture.finish();
        closed.unwrap();
        assert_eq!(first.code(), repeated.code());
        assert_eq!(phase, PoolTargetPhase::Failed);
        assert_eq!(starts, expected_reads);
    }
}

#[test]
fn foreign_runtime_changed_policy_and_expiry_refuse_before_any_new_native_read() {
    let fixture = Fixture::new();
    let foreign = Fixture::new();
    let mut owner =
        PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, end()).unwrap();
    let wrong = owner
        .observe(&foreign.runtime, &fixture.policy)
        .unwrap_err();
    owner.close(&fixture.runtime).unwrap();
    let mut owner =
        PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, end()).unwrap();
    let mut changed = fixture.policy.clone();
    changed.cpu_weight += 1;
    let policy_error = owner.observe(&fixture.runtime, &changed).unwrap_err();
    owner.close(&fixture.runtime).unwrap();
    let mut owner =
        PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, Instant::now()).unwrap();
    let expired = owner
        .observe(&fixture.runtime, &fixture.policy)
        .unwrap_err();
    owner.close(&fixture.runtime).unwrap();
    let starts = fixture.starts();
    let foreign_starts = foreign.starts();
    fixture.finish();
    foreign.finish();
    assert_eq!(wrong.code(), "WORKER_POOL_TARGET_RUNTIME_CHANGED");
    assert_eq!(policy_error.code(), "WORKER_POOL_TARGET_POLICY_CHANGED");
    assert_eq!(expired.code(), "WORKER_POOL_TARGET_DEADLINE");
    assert_eq!(starts + foreign_starts, 0);
}

#[test]
fn successful_round_does_not_renew_deadline_and_late_first_stop_cancels_forward_reads() {
    for stop in [false, true] {
        let fixture = Fixture::new();
        let ceiling = Instant::now() + Duration::from_millis(300);
        let mut owner =
            PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, ceiling).unwrap();
        let first = owner.observe(&fixture.runtime, &fixture.policy);
        if stop {
            fixture.runtime.request_stop();
        } else {
            std::thread::sleep(ceiling.saturating_duration_since(Instant::now()));
        }
        let second = owner.observe(&fixture.runtime, &fixture.policy);
        let starts = fixture.starts();
        let closed = owner.close(&fixture.runtime);
        fixture.finish();
        first.unwrap();
        closed.unwrap();
        assert!(second.is_err());
        assert_eq!(
            starts, 3,
            "no renewed read round after original budget/stop"
        );
    }
}

#[test]
fn genuine_consumed_query_close_stays_owned_and_cannot_issue_or_claim_closed() {
    if crate::test_process::isolate_case(
        "worker_pool::target_observation_tests::genuine_consumed_query_close_stays_owned_and_cannot_issue_or_claim_closed",
    ) {
        return;
    }
    let fixture = Fixture::new();
    fixture.hooks.close_failed.store(true, Ordering::SeqCst);
    let mut owner =
        PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, end()).unwrap();
    let first = owner
        .observe(&fixture.runtime, &fixture.policy)
        .unwrap_err();
    fixture.hooks.close_failed.store(false, Ordering::SeqCst);
    let second = owner
        .observe(&fixture.runtime, &fixture.policy)
        .unwrap_err();
    let closed = owner.close(&fixture.runtime);
    let repeated_close = owner.close(&fixture.runtime);
    let runtime_closed = fixture.runtime.close(end());
    fs::write(
        fixture.root.join("unknown-retained"),
        b"same query owner retained; no closure credit",
    )
    .unwrap();
    assert!(
        matches!(first, PoolTargetObservationError::Engine(ref error) if error.is_uncertain() && error.fault()==EngineFault::Finalization)
    );
    assert_eq!(second.code(), first.code());
    assert!(closed.is_err() && repeated_close.is_err() && runtime_closed.is_err());
    assert_ne!(owner.phase(), PoolTargetPhase::Closed);
    assert_eq!(fixture.starts(), 1);
}

#[test]
fn invalid_policy_refuses_capture_and_known_query_failure_retains_only_its_original_read() {
    let fixture = Fixture::new();
    let mut invalid = fixture.policy.clone();
    invalid.memory_max_mi_b = 1;
    let invalid_refused =
        PoolTargetObservation::capture(&fixture.runtime, &invalid, end()).is_err();
    fs::write(
        fixture.root.join("query-refused"),
        b"fixed query exits nonzero",
    )
    .unwrap();
    let mut owner =
        PoolTargetObservation::capture(&fixture.runtime, &fixture.policy, end()).unwrap();
    let first = owner
        .observe(&fixture.runtime, &fixture.policy)
        .unwrap_err();
    fs::remove_file(fixture.root.join("query-refused")).unwrap();
    let repeated = owner
        .observe(&fixture.runtime, &fixture.policy)
        .unwrap_err();
    let starts = fixture.starts();
    let closed = owner.close(&fixture.runtime);
    fixture.finish();
    closed.unwrap();
    assert!(invalid_refused);
    assert!(
        matches!(first, PoolTargetObservationError::Engine(ref error) if !error.is_uncertain() && error.fault()==EngineFault::Exit)
    );
    assert_eq!(first.code(), repeated.code());
    assert_eq!(starts, 1);
}
