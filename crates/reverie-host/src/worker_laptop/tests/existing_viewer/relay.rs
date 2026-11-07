use super::*;
use crate::worker_storage::LaunchReceiptObservation;
fn receipt(fixture: &Fixture, storage: &mut LaunchStorage) -> LaunchReceiptObservation {
    storage.prepare_runtime_directory().unwrap();
    fs::write(
        fixture.root.join("state").join(SID).join("runtime.json"),
        br#"{"exit":"original.exit"}"#,
    )
    .unwrap();
    storage.observe_launch_receipt().unwrap()
}
#[test]
fn actual_relay_retention_returns_same_box_and_bound_receipt_without_native_purpose_escape() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::existing_viewer::relay::actual_relay_retention_returns_same_box_and_bound_receipt_without_native_purpose_escape",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let (mut storage, plan, request, inspected) = originals(&fixture);
    let address = (&*storage) as *const LaunchStorage;
    let receipt = receipt(&fixture, &mut storage);
    let exit = receipt.exit_path_data().clone();
    let existing = fixture
        .runtime()
        .retain_existing_relay(storage, plan, request, inspected, receipt)
        .unwrap_or_else(|error| panic!("{}", error.cause()));
    assert!(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .is_err()
    );
    drop(fixture.runtime().reclaim_existing_relay(&existing).unwrap());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    let viewer = start(&fixture, &existing);
    assert!(viewer.same_existing(&existing));
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    let (storage, _plan, _request, _inspected, receipt, outcome) = fixture
        .runtime()
        .reclaim_existing_relay(&existing)
        .unwrap()
        .into_parts();
    assert!(outcome.is_none());
    assert!(std::ptr::eq(&*storage, address));
    assert_eq!(receipt.exit_path_data(), &exit);
    receipt
        .assert_storage_owner(fixture.runtime(), &storage)
        .unwrap();
    assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
    storage.close(end()).unwrap();
}
#[test]
fn same_path_foreign_receipt_refuses_before_native_constructor_and_returns_all_originals() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::existing_viewer::relay::same_path_foreign_receipt_refuses_before_native_constructor_and_returns_all_originals",
    ) {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (mut old, _plan, _request, _inspected) = originals(&fixture);
    let receipt = receipt(&fixture, &mut old);
    old.close(end()).unwrap();
    let (storage, plan, request, inspected) = originals(&fixture);
    let address = (&*storage) as *const LaunchStorage;
    let error = fixture
        .runtime()
        .retain_existing_relay(storage, plan, request, inspected, receipt)
        .err()
        .unwrap();
    assert_eq!(error.cause().code(), "WORKER_RECEIPT_OWNER_CHANGED");
    let (storage, plan, request, inspected, receipt, _cause) = error.into_parts();
    assert!(std::ptr::eq(&*storage, address));
    assert_eq!(request.session(), plan.session());
    inspected.assert_plan(fixture.runtime(), &plan).unwrap();
    assert!(
        receipt
            .assert_storage_owner(fixture.runtime(), &storage)
            .is_err()
    );
    assert!(
        fixture
            .runtime()
            .laptop_workflows()
            .records
            .lock()
            .unwrap()
            .is_empty()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
    storage.close(end()).unwrap();
}
#[test]
fn native_only_owner_cannot_be_reclaimed_as_a_bound_relay() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::existing_viewer::relay::native_only_owner_cannot_be_reclaimed_as_a_bound_relay",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let existing = retain(&fixture, originals(&fixture));
    assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
    restore(&fixture, &existing).close(end()).unwrap();
}
