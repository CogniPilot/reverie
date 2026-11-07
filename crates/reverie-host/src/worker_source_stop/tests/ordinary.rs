//! Real storage, original plan/inspection and controlled native process owner.
//! The fixed Rust engine fixture cannot signal an arbitrary host process.
use super::*;
use crate::worker_launch::{ExistingProcessIncarnation, ObservedCreatePlan};
fn inputs(
    fixture: &Fixture,
) -> (
    Box<LaunchStorage>,
    ObservedCreatePlan,
    ExistingProcessIncarnation,
) {
    let mut storage = fixture.storage();
    storage.prepare_cold_launch_storage().unwrap();
    storage.prepare_runtime_directory().unwrap();
    let plan = fixture
        .runtime
        .prepare_laptop_plan(fixture.config.clone(), fixture.config.clone(), &storage)
        .unwrap();
    let previous = plan
        .inspect_existing(&fixture.runtime, end())
        .unwrap()
        .unwrap();
    let process = previous
        .capture_running_replacement_process(&fixture.runtime, &plan, end())
        .unwrap();
    (storage, plan, process)
}
fn retain(fixture: &Fixture) -> (OrdinaryReplacementStop, *const LaunchStorage) {
    let (storage, plan, process) = inputs(fixture);
    let address = std::ptr::from_ref(storage.as_ref());
    let owner = fixture
        .runtime
        .retain_ordinary_replacement_stop(storage, plan, process, Some(end()))
        .unwrap_or_else(|_| panic!("genuine original inputs"));
    (owner, address)
}
#[test]
fn actual_ordinary_stop_returns_same_box_and_original_process_once_without_releasing_lease() {
    if isolated(
        "worker_source_stop::tests::ordinary::actual_ordinary_stop_returns_same_box_and_original_process_once_without_releasing_lease",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (mut owner, address) = retain(&fixture);
    assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
    owner.inspect(&fixture.runtime).unwrap();
    owner
        .stop_after_policy(
            &fixture.runtime,
            &worker_config::policy_digest(&fixture.config),
        )
        .unwrap();
    assert!(fixture.root.join("source-reaped").exists());
    fixture.assert_held();
    let (storage, plan, process) = owner
        .take_stopped(&fixture.runtime, end())
        .unwrap()
        .into_parts();
    assert_eq!(std::ptr::from_ref(storage.as_ref()), address);
    process
        .assert_storage_owner(&fixture.runtime, &storage)
        .unwrap();
    process.assert_plan(&fixture.runtime, &plan).unwrap();
    assert_eq!(process.start(), fixture.start);
    assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
    assert!(owner.inspect(&fixture.runtime).is_err());
    fixture.assert_held();
    let trace = fixture.trace();
    assert_eq!(
        trace.len(),
        4,
        "first inspect plus fresh inspect/stop/exact-CID inspect"
    );
    assert!(trace[2].starts_with("stop\0--time\0"));
    storage.close(end()).unwrap();
}
#[test]
fn foreign_plan_refuses_before_new_engine_work_and_returns_all_original_inputs() {
    if isolated(
        "worker_source_stop::tests::ordinary::foreign_plan_refuses_before_new_engine_work_and_returns_all_original_inputs",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (storage, plan, process) = inputs(&fixture);
    let address = std::ptr::from_ref(storage.as_ref());
    let other = fixture
        .runtime
        .prepare_laptop_plan(fixture.config.clone(), fixture.config.clone(), &storage)
        .unwrap();
    let failure = fixture
        .runtime
        .retain_ordinary_replacement_stop(storage, other, process, Some(end()))
        .err()
        .unwrap();
    let (storage, other, process, cause) = failure.into_parts();
    assert_eq!(cause.code(), "WORKER_ORDINARY_STOP_OBSERVATION");
    assert_eq!(std::ptr::from_ref(storage.as_ref()), address);
    assert!(process.assert_plan(&fixture.runtime, &other).is_err());
    assert_eq!(fixture.trace().len(), 1);
    fixture.assert_held();
    let mut owner = fixture
        .runtime
        .retain_ordinary_replacement_stop(storage, plan, process, Some(end()))
        .unwrap_or_else(|_| panic!("same returned originals"));
    owner.inspect(&fixture.runtime).unwrap();
    owner
        .stop_after_policy(
            &fixture.runtime,
            &worker_config::policy_digest(&fixture.config),
        )
        .unwrap();
    let (storage, _, _) = owner
        .take_stopped(&fixture.runtime, end())
        .unwrap()
        .into_parts();
    storage.close(end()).unwrap();
}
#[test]
fn changed_post_stop_metadata_keeps_original_box_after_native_settlement_and_drop() {
    if isolated(
        "worker_source_stop::tests::ordinary::changed_post_stop_metadata_keeps_original_box_after_native_settlement_and_drop",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (mut owner, _) = retain(&fixture);
    let mut changed = fixture.row.clone();
    changed["State"] = serde_json::json!({"Running":false,"Pid":0});
    changed["Image"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
    fixture.write_rows("after.json", &changed);
    owner.inspect(&fixture.runtime).unwrap();
    assert!(
        owner
            .stop_after_policy(
                &fixture.runtime,
                &worker_config::policy_digest(&fixture.config)
            )
            .is_err()
    );
    assert!(fixture.root.join("source-reaped").exists());
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
    assert!(owner.inspect(&fixture.runtime).is_err());
    assert!(owner.failure().is_some());
    fixture.assert_held();
    let calls = fixture.trace().len();
    drop(owner);
    fixture.assert_held();
    assert_eq!(fixture.trace().len(), calls, "Drop never replays a stop");
}
#[test]
fn still_running_stop_uses_original_incarnation_then_exact_cid_kill() {
    if isolated(
        "worker_source_stop::tests::ordinary::still_running_stop_uses_original_incarnation_then_exact_cid_kill",
    ) {
        return;
    }
    let fixture = Fixture::new("kill-requested");
    fixture.write_rows("after.json", &fixture.row);
    let (mut owner, _) = retain(&fixture);
    owner.inspect(&fixture.runtime).unwrap();
    owner
        .stop_after_policy(
            &fixture.runtime,
            &worker_config::policy_digest(&fixture.config),
        )
        .unwrap();
    let trace = fixture.trace();
    assert_eq!(trace.len(), 6);
    assert!(trace[4].starts_with("kill\0"));
    assert!(fixture.root.join("source-reaped").exists());
    fixture.assert_held();
    let (storage, _, _) = owner
        .take_stopped(&fixture.runtime, end())
        .unwrap()
        .into_parts();
    storage.close(end()).unwrap();
}

#[test]
fn lost_reply_after_real_stop_retains_original_resource_after_local_native_settlement() {
    if isolated(
        "worker_source_stop::tests::ordinary::lost_reply_after_real_stop_retains_original_resource_after_local_native_settlement",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (storage, plan, process) = inputs(&fixture);
    std::fs::write(fixture.root.join("hold-stop-reply"), b"owned fixture").unwrap();
    let deadline = Instant::now() + std::time::Duration::from_millis(150);
    let mut owner = fixture
        .runtime
        .retain_ordinary_replacement_stop(storage, plan, process, Some(deadline))
        .unwrap_or_else(|_| panic!("original inputs"));
    owner.inspect(&fixture.runtime).unwrap();
    assert!(
        owner
            .stop_after_policy(
                &fixture.runtime,
                &worker_config::policy_digest(&fixture.config)
            )
            .is_err()
    );
    assert!(fixture.root.join("source-reaped").exists());
    assert!(
        fixture.root.join("stop-reply-held").exists(),
        "actual native effect preceded the lost reply"
    );
    fixture.assert_held();
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
    assert!(owner.inspect(&fixture.runtime).is_err());
    assert!(owner.failure().is_some());
    let calls = fixture.trace().len();
    assert_eq!(calls, 3, "no readback or replay after the lost stop reply");
    drop(owner);
    fixture.assert_held();
    assert_eq!(fixture.trace().len(), calls);
}
