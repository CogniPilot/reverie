//! Same real lease/Box/plan and owned Rust target, never a live engine.
use super::*;
use crate::worker_launch::{ExistingLaptopInspection, ObservedCreatePlan};
use std::fs;
fn inputs(
    fixture: &Fixture,
) -> (
    Box<LaunchStorage>,
    ObservedCreatePlan,
    ExistingLaptopInspection,
) {
    fs::write(fixture.root.join("legacy-stop"), b"own fixed fixture").unwrap();
    fs::write(fixture.root.join("container-census"), b"").unwrap();
    fs::write(fixture.root.join("network-census"), b"").unwrap();
    let mut storage = fixture.storage();
    storage.prepare_cold_launch_storage().unwrap();
    storage.prepare_runtime_directory().unwrap();
    let plan = fixture
        .runtime
        .prepare_laptop_plan(fixture.config.clone(), fixture.config.clone(), &storage)
        .unwrap();
    let inspected = plan
        .inspect_existing(&fixture.runtime, end())
        .unwrap()
        .unwrap();
    (storage, plan, inspected)
}
fn retain(fixture: &Fixture) -> (OrdinaryLaptopStop, *const LaunchStorage) {
    let (storage, plan, inspected) = inputs(fixture);
    let address = std::ptr::from_ref(storage.as_ref());
    let owner = fixture
        .runtime
        .retain_ordinary_laptop_stop(storage, plan, inspected, end())
        .unwrap_or_else(|_| panic!("same real inputs"));
    (owner, address)
}
fn restore(fixture: &Fixture, owner: &mut OrdinaryLaptopStop, address: *const LaunchStorage) {
    let (storage, plan, original) = owner
        .take_stopped(&fixture.runtime, end())
        .unwrap()
        .into_parts();
    assert_eq!(std::ptr::from_ref(storage.as_ref()), address);
    original
        .unwrap()
        .assert_plan(&fixture.runtime, &plan)
        .unwrap();
    fixture.assert_held();
    assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
    storage.close(end()).unwrap();
}
#[test]
fn actual_optional_stop_then_false_inspect_returns_same_box_without_lease_release() {
    if isolated(
        "worker_source_stop::tests::legacy::actual_optional_stop_then_false_inspect_returns_same_box_without_lease_release",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (mut owner, address) = retain(&fixture);
    fs::write(
        fixture.root.join("legacy-stop-nonzero"),
        b"optional nonzero",
    )
    .unwrap();
    owner.stop_after_admission(&fixture.runtime).unwrap();
    assert!(fixture.root.join("source-reaped").exists());
    assert!(!fixture.root.join("kill-requested").exists());
    assert!(owner.stop_after_admission(&fixture.runtime).is_err());
    restore(&fixture, &mut owner, address);
}
#[test]
fn actual_running_after_stop_requires_kill_and_positive_final_inspect() {
    if isolated(
        "worker_source_stop::tests::legacy::actual_running_after_stop_requires_kill_and_positive_final_inspect",
    ) {
        return;
    }
    let fixture = Fixture::new("kill-requested");
    let (mut owner, address) = retain(&fixture);
    fixture.write_rows("after.json", &fixture.row);
    owner.stop_after_admission(&fixture.runtime).unwrap();
    assert!(fixture.root.join("source-reaped").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("kill-requested")).unwrap(),
        fixture.row["Id"].as_str().unwrap()
    );
    restore(&fixture, &mut owner, address);
}
#[test]
fn optional_inspect_failure_with_live_target_census_never_releases_or_replays_after_settlement() {
    if isolated(
        "worker_source_stop::tests::legacy::optional_inspect_failure_with_live_target_census_never_releases_or_replays_after_settlement",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let (mut owner, _) = retain(&fixture);
    fs::write(
        fixture.root.join("legacy-failed-inspect"),
        b"unknown inspect",
    )
    .unwrap();
    fs::write(
        fixture.root.join("container-census"),
        format!("{} test-agent-{SID}\n", fixture.row["Id"].as_str().unwrap()),
    )
    .unwrap();
    assert!(owner.stop_after_admission(&fixture.runtime).is_err());
    assert!(!fixture.root.join("source-reaped").exists());
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
    let count = fixture.trace().len();
    assert!(owner.stop_after_admission(&fixture.runtime).is_err());
    assert_eq!(fixture.trace().len(), count);
    fixture.assert_held();
    drop(owner);
    fixture.assert_held();
}
#[test]
fn missing_unobserved_target_requires_actual_complete_census_before_known_return() {
    if isolated(
        "worker_source_stop::tests::legacy::missing_unobserved_target_requires_actual_complete_census_before_known_return",
    ) {
        return;
    }
    let mut fixture = Fixture::new("never");
    let (storage, plan, original) = inputs(&fixture);
    drop(original);
    fixture.release_target();
    fs::write(
        fixture.root.join("legacy-missing"),
        b"actual fixture target reaped",
    )
    .unwrap();
    let address = std::ptr::from_ref(storage.as_ref());
    let mut owner = fixture
        .runtime
        .retain_unobserved_ordinary_laptop_stop_for_worker(storage, plan)
        .unwrap_or_else(|_| panic!("genuine original owner"));
    owner.stop_after_admission(&fixture.runtime).unwrap();
    assert!(!fixture.root.join("stop-requested").exists());
    let (storage, _, original) = owner
        .take_stopped(&fixture.runtime, end())
        .unwrap()
        .into_parts();
    assert_eq!(std::ptr::from_ref(storage.as_ref()), address);
    assert!(original.is_none());
    fixture.assert_held();
    storage.close(end()).unwrap();
}
#[test]
fn owned_network_uses_immutable_ids_and_failed_removal_retains_unknown() {
    if isolated(
        "worker_source_stop::tests::legacy::owned_network_uses_immutable_ids_and_failed_removal_retains_unknown",
    ) {
        return;
    }
    for retained in [false, true] {
        let fixture = Fixture::new("stop-requested");
        let (mut owner, address) = retain(&fixture);
        fixture.write_rows("network-before.json", &serde_json::json!({"Id":"b".repeat(64),"Name":format!("test-agent-{SID}-lan"),"Labels":{"reverie.worker":"test","reverie.session":SID}}));
        if retained {
            fs::write(
                fixture.root.join("legacy-network-retained"),
                b"optional rm failure",
            )
            .unwrap();
        }
        let result = owner.stop_after_admission(&fixture.runtime);
        assert_eq!(result.is_err(), retained);
        assert_eq!(
            fs::read_to_string(fixture.root.join("network-disconnected")).unwrap(),
            "b".repeat(64)
        );
        if retained {
            owner.settle_native(&fixture.runtime, end()).unwrap();
            assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
            fixture.assert_held();
        } else {
            restore(&fixture, &mut owner, address);
        }
    }
}
#[test]
fn name_replacement_and_foreign_runtime_refuse_before_stop_effects() {
    if isolated(
        "worker_source_stop::tests::legacy::name_replacement_and_foreign_runtime_refuse_before_stop_effects",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let other = Fixture::new("never");
    let (mut owner, _) = retain(&fixture);
    assert!(owner.stop_after_admission(&other.runtime).is_err());
    let mut replaced = fixture.row.clone();
    replaced["Id"] = serde_json::json!("f".repeat(64));
    fixture.write_rows("before.json", &replaced);
    assert!(owner.stop_after_admission(&fixture.runtime).is_err());
    assert!(!fixture.root.join("stop-requested").exists());
    fixture.assert_held();
}
#[test]
fn lost_stop_reply_remains_unknown_after_real_target_reaped_and_exact_client_settled() {
    if isolated(
        "worker_source_stop::tests::legacy::lost_stop_reply_remains_unknown_after_real_target_reaped_and_exact_client_settled",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (storage, plan, inspected) = inputs(&fixture);
    let mut owner = fixture
        .runtime
        .retain_ordinary_laptop_stop(
            storage,
            plan,
            inspected,
            Instant::now() + std::time::Duration::from_millis(150),
        )
        .unwrap_or_else(|_| panic!("same inputs"));
    fs::write(
        fixture.root.join("hold-stop-reply"),
        b"real effect before lost reply",
    )
    .unwrap();
    assert!(owner.stop_after_admission(&fixture.runtime).is_err());
    assert!(fixture.root.join("stop-reply-held").exists());
    assert!(fixture.root.join("source-reaped").exists());
    fs::write(fixture.root.join("release-stop-reply"), b"owned settlement").unwrap();
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
    fixture.assert_held();
}
#[test]
fn foreign_network_stays_untouched_after_known_stop_and_first_stop_allows_bounded_cleanup() {
    if isolated(
        "worker_source_stop::tests::legacy::foreign_network_stays_untouched_after_known_stop_and_first_stop_allows_bounded_cleanup",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (mut owner, address) = retain(&fixture);
    fixture.write_rows("network-before.json", &serde_json::json!({"Id":"f".repeat(64),"Name":format!("test-agent-{SID}-lan"),"Labels":{"reverie.worker":"foreign","reverie.session":SID}}));
    fixture.runtime.request_stop();
    owner.stop_after_admission(&fixture.runtime).unwrap();
    assert!(!fixture.root.join("network-disconnected").exists());
    assert!(!fixture.root.join("network-removed").exists());
    restore(&fixture, &mut owner, address);
}
#[test]
fn actual_worker_policy_has_no_component_body_cap_across_multiple_fixed_client_calls() {
    if isolated(
        "worker_source_stop::tests::legacy::actual_worker_policy_has_no_component_body_cap_across_multiple_fixed_client_calls",
    ) {
        return;
    }
    for worker in [false, true] {
        let fixture = Fixture::new("stop-requested");
        let (storage, plan, original) = inputs(&fixture);
        let address = std::ptr::from_ref(storage.as_ref());
        fs::write(
            fixture.root.join("legacy-query-delay"),
            b"80ms each fixed query",
        )
        .unwrap();
        let mut owner = if worker {
            fixture
                .runtime
                .retain_ordinary_laptop_stop_for_worker(storage, plan, original)
        } else {
            fixture.runtime.retain_ordinary_laptop_stop(
                storage,
                plan,
                original,
                Instant::now() + std::time::Duration::from_millis(120),
            )
        }
        .unwrap_or_else(|_| panic!("same actual original inputs"));
        let result = owner.stop_after_admission(&fixture.runtime);
        assert_eq!(result.is_ok(), worker);
        if worker {
            assert!(fixture.root.join("source-reaped").exists());
            assert!(
                fixture.trace().len() >= 6,
                "multiple independently bounded native calls"
            );
            restore(&fixture, &mut owner, address);
        } else {
            owner.settle_native(&fixture.runtime, end()).unwrap();
            assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
            fixture.assert_held();
        }
    }
}
