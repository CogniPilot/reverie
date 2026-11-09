//! Real employee lease/plan and fixed captured query; no container engine.
use super::*;
use crate::worker_storage::StorageLease;

fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::direct_finalization::{name}"
    ))
}
fn controls(fixture: &Fixture, running: bool) {
    fs::write(fixture.root.join("started-laptop"), SID).unwrap();
    fs::write(
        fixture.root.join("existing-stop-control"),
        b"fixed owning reader",
    )
    .unwrap();
    let row = json!([{"Id":"c".repeat(64),"Name":format!("/fixture-agent-{SID}"),"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},"State":{"Running":running}}]);
    fs::write(
        fixture.root.join("existing-inspect.json"),
        serde_json::to_vec(&row).unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("existing-after.json"),
        serde_json::to_vec(&row).unwrap(),
    )
    .unwrap();
}
#[test]
fn known_live_observation_returns_same_box_once_and_foreign_runtime_cannot_consume_it() {
    if isolated(
        "known_live_observation_returns_same_box_once_and_foreign_runtime_cannot_consume_it",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let foreign = Fixture::employee("created-viewer-echo");
    let (storage, plan) = direct_resources(&fixture);
    let address = std::ptr::from_ref(storage.as_ref());
    let mut owner = fixture
        .runtime()
        .retain_direct_final_storage(storage, plan)
        .unwrap();
    controls(&fixture, true);
    let observed = owner.observe(fixture.runtime()).unwrap();
    assert!(observed.is_live());
    assert!(owner.observe(fixture.runtime()).is_err());
    let cause = owner.reclaim(foreign.runtime(), &observed).err().unwrap();
    assert_eq!(cause.code(), "WORKER_LAPTOP_PLAN");
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    let (storage, plan, live) = owner.reclaim(fixture.runtime(), &observed).unwrap();
    assert!(owner.reclaim(fixture.runtime(), &observed).is_err());
    assert!(live);
    assert_eq!(std::ptr::from_ref(storage.as_ref()), address);
    plan.assert_storage_owner(fixture.runtime(), &storage)
        .unwrap();
    // Component fixture teardown only; the live DATA granted no release.
    storage.close(end()).unwrap();
}
#[test]
fn no_original_cid_and_failed_inspect_need_successful_absence_census_before_same_box_handoff() {
    if isolated(
        "no_original_cid_and_failed_inspect_need_successful_absence_census_before_same_box_handoff",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let (storage, plan) = direct_resources(&fixture);
    let address = std::ptr::from_ref(storage.as_ref());
    let mut owner = fixture
        .runtime()
        .retain_direct_final_storage(storage, plan)
        .unwrap();
    controls(&fixture, false);
    fs::write(
        fixture.root.join("stopped-laptop"),
        b"own failed optional inspect control",
    )
    .unwrap();
    fs::write(
        fixture.root.join("existing-stop-failed-inspect"),
        b"unknown optional query",
    )
    .unwrap();
    fs::write(fixture.root.join("existing-stop-census"), b"").unwrap();
    let observed = owner.observe(fixture.runtime()).unwrap();
    assert!(!observed.is_live());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert!(trace.contains("ps\0--all\0--no-trunc\0--format\0{{.ID}} {{.Names}}"));
    let (storage, _, live) = owner.reclaim(fixture.runtime(), &observed).unwrap();
    assert!(!live);
    assert_eq!(std::ptr::from_ref(storage.as_ref()), address);
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    storage.close(end()).unwrap();
}
#[test]
fn failed_census_is_one_shot_and_default_drop_keeps_actual_employee_lease() {
    if isolated("failed_census_is_one_shot_and_default_drop_keeps_actual_employee_lease") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let (storage, plan) = direct_resources(&fixture);
    let mut owner = fixture
        .runtime()
        .retain_direct_final_storage(storage, plan)
        .unwrap();
    controls(&fixture, false);
    fs::write(
        fixture.root.join("stopped-laptop"),
        b"optional inspect failure",
    )
    .unwrap();
    fs::write(
        fixture.root.join("existing-stop-failed-inspect"),
        b"unknown query",
    )
    .unwrap();
    fs::write(
        fixture.root.join("existing-stop-census"),
        format!("{} fixture-agent-{SID}\n", "c".repeat(64)),
    )
    .unwrap();
    assert!(owner.observe(fixture.runtime()).is_err());
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    fs::write(fixture.root.join("existing-stop-census"), b"").unwrap();
    assert!(owner.observe(fixture.runtime()).is_err());
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    drop(owner);
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
}

#[test]
fn unknown_native_descriptor_close_keeps_same_query_and_lease_after_owner_drop() {
    if isolated("unknown_native_descriptor_close_keeps_same_query_and_lease_after_owner_drop") {
        return;
    }
    use std::sync::atomic::Ordering;
    let hooks = crate::captured_client::test_hooks::Hooks::default();
    let fixture = Fixture::employee_with_hooks("created-viewer-echo", hooks.clone());
    let (storage, plan) = direct_resources(&fixture);
    let mut owner = fixture
        .runtime()
        .retain_direct_final_storage(storage, plan)
        .unwrap();
    controls(&fixture, true);
    let started = hooks.starts.load(Ordering::Acquire);
    hooks.close_failed.store(true, Ordering::Release);
    assert!(owner.observe(fixture.runtime()).is_err());
    assert_eq!(hooks.starts.load(Ordering::Acquire), started + 1);
    let diagnostic = owner.storage_owner_status();
    let repeated = owner.storage_owner_status();
    assert_eq!(diagnostic, repeated);
    assert!(matches!(
        diagnostic,
        reverie_contracts::worker_storage_status::OwnerObservation::Observed {
            final_storage_check: Some(reverie_contracts::worker_storage_status::CheckPhase::Failed),
            native_pending: Some(true),
            ..
        }
    ));
    assert_eq!(hooks.starts.load(Ordering::Acquire), started + 1);
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    assert!(owner.observe(fixture.runtime()).is_err());
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    drop(owner);
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(fixture.runtime().close(end()).is_err());
}
