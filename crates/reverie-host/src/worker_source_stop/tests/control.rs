//! Real owned target/process and held storage; no Docker or fabricated lease.
use super::*;
use std::fs;
mod census;
fn prepare(fixture: &Fixture) -> (ControlLaptopStop, *const LaunchStorage) {
    fs::write(fixture.root.join("legacy-stop"), b"closed C fixture").unwrap();
    fs::write(fixture.root.join("container-census"), b"").unwrap();
    fs::write(fixture.root.join("network-census"), b"").unwrap();
    let storage = fixture.storage();
    let address = std::ptr::from_ref(storage.as_ref());
    let owner = fixture
        .runtime
        .retain_control_laptop_stop(storage, &fixture.config, end())
        .unwrap_or_else(|_| panic!("same actual storage"));
    (owner, address)
}
#[test]
fn actual_control_stop_reaps_target_returns_same_box_and_refuses_effect_replay() {
    if isolated(
        "worker_source_stop::tests::control::actual_control_stop_reaps_target_returns_same_box_and_refuses_effect_replay",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (mut owner, address) = prepare(&fixture);
    let stopped = owner.stop_after_admission(&fixture.runtime);
    let replay = owner.stop_after_admission(&fixture.runtime);
    fixture.assert_held();
    let returned = owner.take_stopped_storage(&fixture.runtime, end());
    let storage = returned.unwrap();
    let same = std::ptr::from_ref(storage.as_ref()) == address;
    let close = storage.close(end());
    // Real target teardown is performed by the owning Fixture on every path.
    stopped.unwrap();
    replay.unwrap_err();
    close.unwrap();
    assert!(same);
    assert!(fixture.root.join("source-reaped").exists());
    assert!(
        fixture
            .trace()
            .iter()
            .any(|line| line.starts_with("stop\0--time\x002\0"))
    );
}
#[test]
fn post_stop_inspection_uncertainty_keeps_same_resource_without_stop_replay() {
    if isolated(
        "worker_source_stop::tests::control::post_stop_inspection_uncertainty_keeps_same_resource_without_stop_replay",
    ) {
        return;
    }
    uncertain_inspection(Refusal::AfterStop);
}
#[test]
fn pre_stop_inspection_uncertainty_dispatches_no_stop_and_retains_same_resource() {
    if isolated(
        "worker_source_stop::tests::control::pre_stop_inspection_uncertainty_dispatches_no_stop_and_retains_same_resource",
    ) {
        return;
    }
    uncertain_inspection(Refusal::BeforeStop);
}
enum Refusal {
    BeforeStop,
    AfterStop,
}
fn uncertain_inspection(refusal: Refusal) {
    let mut fixture = Fixture::new("never");
    let (mut owner, _) = prepare(&fixture);
    let flag = match refusal {
        Refusal::BeforeStop => "legacy-missing",
        Refusal::AfterStop => "legacy-failed-inspect",
    };
    fs::write(fixture.root.join(flag), b"owned inspect refusal").unwrap();
    fs::write(
        fixture.root.join("container-census"),
        format!("{} test-agent-{SID}\n", fixture.row["Id"].as_str().unwrap()),
    )
    .unwrap();
    let body = owner.stop_after_admission(&fixture.runtime);
    let settled = owner.settle_native(&fixture.runtime, end());
    let trace = fixture.trace().len();
    let replay = owner.stop_after_admission(&fixture.runtime);
    let returned = owner.take_stopped_storage(&fixture.runtime, end());
    drop(owner);
    fixture.assert_held();
    // Teardown of the actual owned target cannot authorize stop replay or
    // release the retained operational lease. Complete it before verdict.
    fixture.release_target();
    body.unwrap_err();
    settled.unwrap();
    replay.unwrap_err();
    assert!(returned.is_err());
    assert_eq!(fixture.trace().len(), trace);
    match refusal {
        Refusal::BeforeStop => assert!(!fixture.root.join("stop-requested").exists()),
        Refusal::AfterStop => {
            let cid = fixture.row["Id"].as_str().unwrap();
            assert_eq!(
                fs::read_to_string(fixture.root.join("stop-requested")).unwrap(),
                cid
            );
            let stop = format!("stop\0--time\x002\0{cid}");
            assert_eq!(
                fixture.trace().iter().filter(|line| **line == stop).count(),
                1
            );
        }
    }
}
