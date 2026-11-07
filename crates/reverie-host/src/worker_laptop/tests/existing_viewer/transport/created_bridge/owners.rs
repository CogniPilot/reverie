use super::*;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::owners::{name}"
    ))
}
#[test]
fn source_attachment_fences_created_before_journaling_and_old_attachment_cannot_reenter() {
    if isolated(
        "source_attachment_fences_created_before_journaling_and_old_attachment_cannot_reenter",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, original, mut hold) = accepted(&fixture, &service, "original");
    let (created, released) = ready(&fixture, &original);
    assert!(runtime.retain_started_laptop_source(&created).is_err());
    original.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    let source = runtime.retain_started_laptop_source(&created).unwrap();
    assert!(source.same_workflow(&created.workflow));
    assert!(runtime.stop_created_laptop(&created, end()).is_err());
    assert!(
        runtime
            .start_laptop_viewer_session(&released, end())
            .is_err()
    );
    let borrowed = runtime.borrow_started_source_storage(&source).unwrap();
    borrowed.assert_binding(&fixture.source, &sid()).unwrap();
    borrowed.check_resource_current().unwrap();
    assert_eq!(borrowed.paths().session(), &sid());
    assert!(runtime.restore_unclaimed_started_source(&source).is_err());
    drop(borrowed);
    runtime.restore_unclaimed_started_source(&source).unwrap();
    let later = runtime.retain_started_laptop_source(&created).unwrap();
    assert!(runtime.borrow_started_source_storage(&source).is_err());
    assert!(runtime.restore_unclaimed_started_source(&source).is_err());
    assert!(runtime.borrow_started_source_storage(&later).is_ok());
    drop(later);
    assert_eq!(runtime.laptop_workflows().records.lock().unwrap().len(), 1);
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(!fixture.root.join("stopped-laptop").exists());
    service.close(end()).unwrap();
}
#[test]
fn later_j_legacy_stop_consumes_same_storage_only_into_actual_fixed_stop_owner() {
    if isolated("later_j_legacy_stop_consumes_same_storage_only_into_actual_fixed_stop_owner") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, original, mut old_hold) = accepted(&fixture, &service, "original");
    let (created, released) = ready(&fixture, &original);
    let (plan, inspected, _receipt) =
        transfer::inputs(&fixture, &created, &original, &"c".repeat(64));
    original.close_socket(end()).unwrap();
    old_hold.release(end()).unwrap();
    let (_client, next, mut next_hold) = accepted(&fixture, &service, "later");
    let moved = runtime
        .transfer_started_laptop_ordinary_stop_for_worker(&created, plan, inspected, &next)
        .unwrap();
    let (mut stop, phone, _old_request) = moved.into_parts();
    assert!(
        runtime
            .start_laptop_viewer_session(&released, end())
            .is_err()
    );
    assert!(runtime.stop_created_laptop(&created, end()).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    stop_fixture(&fixture);
    stop.stop_after_admission(runtime).unwrap();
    let (storage, _plan, _inspection, _removal) =
        stop.take_stopped(runtime, end()).unwrap().into_cold_parts();
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    fixture.office.close_phone(&phone, end()).unwrap();
    next.close_socket(end()).unwrap();
    next_hold.release(end()).unwrap();
    service.close(end()).unwrap();
    storage.close(end()).unwrap();
}
fn stop_fixture(fixture: &Fixture) {
    fs::write(
        fixture.root.join("existing-stop-control"),
        b"actual fixed stop path",
    )
    .unwrap();
    for (name, running) in [
        ("existing-inspect.json", true),
        ("existing-after.json", false),
    ] {
        fs::write(
            fixture.root.join(name),
            serde_json::to_vec(&json!([{
                "Id":"c".repeat(64),"Name":format!("/fixture-agent-{SID}"),
                "Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},
                "State":{"Running":running}
            }]))
            .unwrap(),
        )
        .unwrap();
    }
    fs::write(fixture.root.join("existing-stop-census"), b"").unwrap();
}
#[test]
fn later_j_replacement_transfer_keeps_real_process_brand_and_cannot_release_on_drop() {
    if isolated("later_j_replacement_transfer_keeps_real_process_brand_and_cannot_release_on_drop")
    {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, original, mut old_hold) = accepted(&fixture, &service, "original");
    let (created, _released) = ready(&fixture, &original);
    let (plan, _old, _receipt) = transfer::inputs(&fixture, &created, &original, &"c".repeat(64));
    fs::write(fixture.root.join("existing-inspect.json"),serde_json::to_vec(&json!([{
        "Id":"c".repeat(64),"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},
        "State":{"Running":true,"Pid":std::process::id()}
    }])).unwrap()).unwrap();
    let inspected = plan.inspect_existing(runtime, end()).unwrap().unwrap();
    let process = inspected
        .capture_running_replacement_process(runtime, &plan, end())
        .unwrap();
    original.close_socket(end()).unwrap();
    old_hold.release(end()).unwrap();
    let (_client, next, mut next_hold) = accepted(&fixture, &service, "later");
    let moved = runtime
        .transfer_started_laptop_replacement_stop_for_worker(&created, plan, process, &next)
        .unwrap();
    let (stop, phone, _old_request) = moved.into_parts();
    assert!(runtime.created_laptop_stop_target(&created).is_err());
    drop(stop);
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(!fixture.root.join("stopped-laptop").exists());
    fixture.office.close_phone(&phone, end()).unwrap();
    next.close_socket(end()).unwrap();
    next_hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
