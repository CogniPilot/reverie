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
    transferred: StartedRelayTransferred,
    connection: WorkerLaunchConnection,
    mut hold: WorkerLaunchHold,
    service: &WorkerReportService,
) {
    let (existing, phone, original_request) = transferred.into_parts();
    assert_eq!(original_request.session(), &sid());
    let runtime = fixture.runtime();
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
    fixture.office.close_phone(&phone, end()).unwrap();
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    storage.close(end()).unwrap();
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
    finish(&fixture, transferred, next, next_hold, &service);
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
    finish(&fixture, transferred, next, next_hold, &service);
}
