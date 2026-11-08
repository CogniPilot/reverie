//! Real owned target/process and held storage; no Docker or fabricated lease.
use super::*;
use std::fs;
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
fn unknown_control_inspection_keeps_same_resource_after_call_settlement_and_drop() {
    if isolated(
        "worker_source_stop::tests::control::unknown_control_inspection_keeps_same_resource_after_call_settlement_and_drop",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let (mut owner, _) = prepare(&fixture);
    fs::write(
        fixture.root.join("legacy-failed-inspect"),
        b"owned inspect refusal",
    )
    .unwrap();
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
    body.unwrap_err();
    settled.unwrap();
    replay.unwrap_err();
    assert!(returned.is_err());
    assert_eq!(fixture.trace().len(), trace);
    assert!(!fixture.root.join("stop-requested").exists());
}
