//! Actual pane chain and real employee/storage/Nix descriptors. No owner is
//! reconstructed from CID/path DATA and no release boolean is supplied.
use super::*;
use crate::{
    native,
    worker_storage::{StorageLease, StorageOwnershipKind},
};
fn pane(fixture: &Fixture) -> (LaptopWorkflow, CreatedLaptop, StartedPane) {
    let (workflow, created, cold) = super::pane::cold(fixture);
    let PaneStart::Started(pane) = fixture.runtime().start_laptop_pane(&cold, end()).unwrap()
    else {
        panic!("actual pane acknowledged")
    };
    (workflow, created, pane)
}
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::guard::{name}"))
}
fn employee_held(fixture: &Fixture, workflow: &LaptopWorkflow) {
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    let record = workflow.record.lock().unwrap();
    assert_eq!(
        record.resources().storage().ownership_kind(),
        StorageOwnershipKind::HeldLease
    );
    record
        .resources()
        .storage()
        .assert_binding(fixture.runtime(), &fixture.source, &sid())
        .unwrap();
}
#[test]
fn actual_guard_close_keeps_employee_lease_and_terminal_stop_reachable() {
    if isolated("actual_guard_close_keeps_employee_lease_and_terminal_stop_reachable") {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let (workflow, created, pane) = pane(&fixture);
    employee_held(&fixture, &workflow);
    assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    let NixGuardRelease::Released(released) = fixture
        .runtime()
        .release_laptop_nix_guard(&pane, end())
        .unwrap()
    else {
        panic!("actual guard finalizers confirmed")
    };
    assert!(released.same_workflow(&workflow));
    NixStoreGuard::acquire_migration(&fixture.source, &sid())
        .unwrap()
        .close()
        .unwrap();
    employee_held(&fixture, &workflow);
    assert!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .is_err()
    );
    assert!(
        workflow
            .record
            .lock()
            .unwrap()
            .resources()
            .held_nix()
            .is_err()
    );
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    employee_held(&fixture, &workflow);
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn consumed_close_refusal_keeps_storage_no_token_and_never_retries_native_close() {
    if isolated("consumed_close_refusal_keeps_storage_no_token_and_never_retries_native_close") {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let (workflow, created, pane) = pane(&fixture);
    native::test_faults::set(None, true);
    assert!(matches!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .unwrap(),
        NixGuardRelease::Retained
    ));
    assert!(matches!(
        workflow.failure().unwrap().as_deref(),
        Some(LaptopError::Nix(_))
    ));
    native::test_faults::set(None, true);
    assert!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .is_err()
    );
    // A refusal did not consume a new native-close attempt. The sentinel is
    // our actual file; the one-shot injection runs AFTER its real close.
    assert!(native::close(fs::File::create(fixture.root.join("close-sentinel")).unwrap()).is_err());
    NixStoreGuard::acquire_migration(&fixture.source, &sid())
        .unwrap()
        .close()
        .unwrap();
    employee_held(&fixture, &workflow);
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Retained
    ));
    assert!(fixture.root.join("stopped-laptop").is_file());
    employee_held(&fixture, &workflow);
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn primary_lock_identity_and_consumed_close_errors_retain_both_without_foreign_unlink() {
    if isolated(
        "primary_lock_identity_and_consumed_close_errors_retain_both_without_foreign_unlink",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let (workflow, created, pane) = pane(&fixture);
    let lock = fixture.root.join("state").join(SID).join("nix.lock");
    fs::rename(&lock, lock.with_extension("original")).unwrap();
    fs::write(&lock, b"foreign replacement remains").unwrap();
    native::test_faults::set(None, true);
    assert!(matches!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .unwrap(),
        NixGuardRelease::Retained
    ));
    assert!(matches!(
        workflow.failure().unwrap().as_deref(),
        Some(LaptopError::Nix(
            crate::worker_nix::NixError::Finalization { .. }
        ))
    ));
    assert_eq!(fs::read(&lock).unwrap(), b"foreign replacement remains");
    assert!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .is_err()
    );
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Retained
    ));
    employee_held(&fixture, &workflow);
}
#[test]
fn wrong_runtime_refusal_keeps_original_guard_owner_usable() {
    if isolated("wrong_runtime_refusal_keeps_original_guard_owner_usable") {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let other = Fixture::new("created-pane-normal");
    let (workflow, _created, pane) = pane(&fixture);
    assert!(
        other
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .is_err()
    );
    assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(matches!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .unwrap(),
        NixGuardRelease::Released(_)
    ));
    employee_held(&fixture, &workflow);
}
#[test]
fn expired_caller_preserves_held_guard_and_never_renews_the_same_attempt() {
    if isolated("expired_caller_preserves_held_guard_and_never_renews_the_same_attempt") {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let (workflow, _created, pane) = pane(&fixture);
    assert!(matches!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, Instant::now())
            .unwrap(),
        NixGuardRelease::Retained
    ));
    assert!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .is_err()
    );
    assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(
        workflow
            .record
            .lock()
            .unwrap()
            .resources()
            .held_nix()
            .is_ok()
    );
    employee_held(&fixture, &workflow);
}
#[test]
fn actual_cleanup_remains_allowed_inside_the_original_stop_budget() {
    if isolated("actual_cleanup_remains_allowed_inside_the_original_stop_budget") {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let (workflow, created, pane) = pane(&fixture);
    let first = fixture.runtime().request_stop();
    assert!(matches!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .unwrap(),
        NixGuardRelease::Released(_)
    ));
    assert_eq!(fixture.runtime().request_stop(), first);
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    employee_held(&fixture, &workflow);
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn expired_first_stop_refuses_fresh_caller_budget_without_guard_consumption() {
    if isolated("expired_first_stop_refuses_fresh_caller_budget_without_guard_consumption") {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let (workflow, _created, pane) = pane(&fixture);
    fixture
        .runtime()
        .installed_engine()
        .expire_stop_for_owned_test();
    let start = Instant::now();
    assert!(matches!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, start + Duration::from_secs(2))
            .unwrap(),
        NixGuardRelease::Retained
    ));
    assert!(start.elapsed() < Duration::from_millis(500));
    assert!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .is_err()
    );
    assert!(
        workflow
            .record
            .lock()
            .unwrap()
            .resources()
            .held_nix()
            .is_ok()
    );
    fixture.retain_after_expired_stop();
}
#[test]
fn terminal_container_cleanup_cannot_later_mint_guard_release() {
    if isolated("terminal_container_cleanup_cannot_later_mint_guard_release") {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let (workflow, created, pane) = pane(&fixture);
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(
        fixture
            .runtime()
            .release_laptop_nix_guard(&pane, end())
            .is_err()
    );
    assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    employee_held(&fixture, &workflow);
}
