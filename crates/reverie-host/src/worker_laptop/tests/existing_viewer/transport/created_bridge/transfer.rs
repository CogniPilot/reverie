use super::*;
use crate::{worker_launch::ExistingLaptopInspection, worker_storage::LaunchReceiptObservation};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::transfer::{name}"
    ))
}
pub(super) fn inputs(
    fixture: &Fixture,
    created: &CreatedLaptop,
    connection: &WorkerLaunchConnection,
    id: &str,
) -> (
    ObservedCreatePlan,
    ExistingLaptopInspection,
    LaunchReceiptObservation,
) {
    let borrowed = fixture
        .runtime()
        .borrow_started_laptop_storage(created, connection)
        .unwrap();
    let plan = borrowed
        .prepare_create_plan(fixture.source.clone(), fixture.source.clone())
        .unwrap();
    let receipt = borrowed.observe_launch_receipt().unwrap();
    drop(borrowed);
    fs::write(
        fixture.root.join("existing-inspect.json"),
        serde_json::to_vec(&json!([{
            "Id":id,"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},
            "State":{"Running":true}
        }]))
        .unwrap(),
    )
    .unwrap();
    let inspected = plan
        .inspect_existing(fixture.runtime(), end())
        .unwrap()
        .unwrap();
    (plan, inspected, receipt)
}
fn finish(
    fixture: &Fixture,
    created: &CreatedLaptop,
    transferred: StartedRelayTransferred,
    connection: WorkerLaunchConnection,
    mut hold: WorkerLaunchHold,
    service: &WorkerReportService,
) {
    let (existing, phone, original_request, handoff) = transferred.into_handoff_parts();
    assert_eq!(original_request.session(), &sid());
    let runtime = fixture.runtime();
    let original_matches = handoff.assert_created(runtime, created).is_ok()
        && handoff.pending_existing(runtime, &existing).is_ok();
    let other_session = ProfileSessionId::parse("bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
    let other = runtime
        .resolve_storage(&fixture.source, &other_session)
        .unwrap()
        .into_legacy()
        .unwrap();
    let foreign_refused = handoff.assert_storage(runtime, &other).is_err();
    other.close(end()).unwrap();
    let ExistingViewerStart::Started(viewer) = runtime
        .start_existing_viewer_for_connection(&existing, &connection, end())
        .unwrap()
    else {
        panic!("same slot real new viewer")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    runtime.close_laptop_viewer(&viewer, end()).unwrap();
    runtime.close_existing_viewer(&existing, end()).unwrap();
    let (storage, _plan, _request, _inspection, _receipt, _failure) = runtime
        .reclaim_existing_relay(&existing)
        .unwrap()
        .into_parts();
    let direct_matches = handoff.assert_storage(runtime, &storage).is_ok();
    fixture.office.close_phone(&phone, end()).unwrap();
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    storage.close(end()).unwrap();
    assert!(original_matches && direct_matches && foreign_refused);
}
#[test]
fn full_inventory_transfer_replaces_same_slot_and_old_created_aliases_are_fenced() {
    if isolated("full_inventory_transfer_replaces_same_slot_and_old_created_aliases_are_fenced") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, original, mut old_hold) = accepted(&fixture, &service, "original");
    let (created, released) = ready(&fixture, &original);
    let (plan, inspected, receipt) = inputs(&fixture, &created, &original, &"c".repeat(64));
    let maximum = runtime.connection_limit();
    for suffix in 1..maximum {
        let session =
            ProfileSessionId::parse(&format!("00000000-0000-4000-8000-{suffix:012}")).unwrap();
        let (nix, plan, request, phone) = fixture.resources_for(&session);
        let _held = runtime
            .retain_laptop_network(&nix, plan, request, phone)
            .unwrap_or_else(|error| panic!("{}", error.cause()));
    }
    assert_eq!(
        runtime.laptop_workflows().records.lock().unwrap().len(),
        maximum
    );
    runtime.cleanup_created_laptop_request(&created).unwrap();
    original.close_socket(end()).unwrap();
    old_hold.release(end()).unwrap();
    let (_next_client, next, next_hold) = accepted(&fixture, &service, "later");
    let transferred = runtime
        .transfer_started_laptop_relay(&created, plan, inspected, receipt, &next)
        .unwrap();
    assert_eq!(
        runtime.laptop_workflows().records.lock().unwrap().len(),
        maximum
    );
    assert!(runtime.created_laptop_stop_target(&created).is_err());
    assert!(
        runtime
            .start_laptop_viewer_session(&released, end())
            .is_err()
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    finish(&fixture, &created, transferred, next, next_hold, &service);
}
#[test]
fn same_original_j_or_foreign_created_identity_cannot_consume_the_record() {
    if isolated("same_original_j_or_foreign_created_identity_cannot_consume_the_record") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, original, mut old_hold) = accepted(&fixture, &service, "original");
    let (created, _released) = ready(&fixture, &original);
    let (plan, inspected, receipt) = inputs(&fixture, &created, &original, &"c".repeat(64));
    assert!(
        runtime
            .transfer_started_laptop_relay(&created, plan, inspected, receipt, &original)
            .is_err()
    );
    let (plan, inspected, receipt) = inputs(&fixture, &created, &original, &"f".repeat(64));
    runtime.cleanup_created_laptop_request(&created).unwrap();
    original.close_socket(end()).unwrap();
    old_hold.release(end()).unwrap();
    let (_client, next, mut next_hold) = accepted(&fixture, &service, "later");
    assert_eq!(
        runtime
            .transfer_started_laptop_relay(&created, plan, inspected, receipt, &next)
            .err()
            .unwrap()
            .code(),
        "WORKER_STARTED_IDENTITY_CHANGED"
    );
    runtime
        .borrow_started_laptop_storage(&created, &next)
        .unwrap()
        .check_resource_current()
        .unwrap();
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    next.close_socket(end()).unwrap();
    next_hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn released_old_j_with_actual_live_viewer_does_not_allow_transfer() {
    if isolated("released_old_j_with_actual_live_viewer_does_not_allow_transfer") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, original, mut old_hold) = accepted(&fixture, &service, "original");
    let (created, released) = ready(&fixture, &original);
    let ViewerStart::Started(viewer) = runtime
        .start_laptop_viewer_session(&released, end())
        .unwrap()
    else {
        panic!("real viewer")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    let (plan, inspected, receipt) = inputs(&fixture, &created, &original, &"c".repeat(64));
    runtime.cleanup_created_laptop_request(&created).unwrap();
    original.close_socket(end()).unwrap();
    old_hold.release(end()).unwrap();
    let (_client, next, next_hold) = accepted(&fixture, &service, "later");
    assert!(
        runtime
            .transfer_started_laptop_relay(&created, plan, inspected, receipt, &next)
            .is_err()
    );
    runtime.close_laptop_viewer(&viewer, end()).unwrap();
    let (plan, inspected, receipt) = inputs(&fixture, &created, &next, &"c".repeat(64));
    let transferred = runtime
        .transfer_started_laptop_relay(&created, plan, inspected, receipt, &next)
        .unwrap();
    finish(&fixture, &created, transferred, next, next_hold, &service);
}

#[test]
fn handoff_keeps_actual_existing_or_direct_finalizer_close_uncertainty_negative() {
    if isolated("handoff_keeps_actual_existing_or_direct_finalizer_close_uncertainty_negative") {
        return;
    }
    use std::sync::atomic::Ordering;
    for direct in [false, true] {
        let hooks = crate::captured_client::test_hooks::Hooks::default();
        let fixture = Fixture::employee_with_hooks("created-viewer-echo", hooks.clone());
        let runtime = fixture.runtime();
        let service = Arc::new(WorkerReportService::from_runtime(runtime));
        let (_client, original, mut old_hold) = accepted(&fixture, &service, "original");
        let (created, _released) = ready(&fixture, &original);
        let (plan, inspected, receipt) = inputs(&fixture, &created, &original, &"c".repeat(64));
        runtime.cleanup_created_laptop_request(&created).unwrap();
        original.close_socket(end()).unwrap();
        old_hold.release(end()).unwrap();
        let (_client, next, mut hold) = accepted(&fixture, &service, "later");
        let (existing, phone, _, handoff) = runtime
            .transfer_started_laptop_relay(&created, plan, inspected, receipt, &next)
            .unwrap()
            .into_handoff_parts();
        runtime.close_existing_viewer(&existing, end()).unwrap();
        let refused = if direct {
            let (storage, plan, _, _, _, _) = runtime
                .reclaim_existing_relay(&existing)
                .unwrap()
                .into_parts();
            let mut owner = runtime.retain_direct_final_storage(storage, plan).unwrap();
            hooks.close_failed.store(true, Ordering::Release);
            assert!(owner.observe(runtime).is_err());
            let starts = hooks.starts.load(Ordering::Acquire);
            let refused = matches!(
                handoff.pending_direct_finalizer(runtime, &owner),
                Err(LaptopError::Recorded(_))
            );
            assert_eq!(hooks.starts.load(Ordering::Acquire), starts);
            drop(owner);
            refused
        } else {
            hooks.close_failed.store(true, Ordering::Release);
            assert!(runtime.observe_existing_final_storage(&existing).is_err());
            let starts = hooks.starts.load(Ordering::Acquire);
            let refused = matches!(
                handoff.pending_existing(runtime, &existing),
                Err(LaptopError::Recorded(_))
            );
            assert_eq!(hooks.starts.load(Ordering::Acquire), starts);
            assert!(runtime.reclaim_existing_relay(&existing).is_err());
            refused
        };
        fixture.office.close_phone(&phone, end()).unwrap();
        next.close_socket(end()).unwrap();
        hold.release(end()).unwrap();
        service.close(end()).unwrap();
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        assert!(runtime.close(end()).is_err());
        assert!(
            refused,
            "recorded consumed-close uncertainty is never Pending"
        );
    }
}
