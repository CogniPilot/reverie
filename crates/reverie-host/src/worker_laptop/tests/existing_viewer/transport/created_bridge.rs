//! Real created pipeline, genuine kernel-peer J and original employee lease.
//! These component controls mint no App admission or service completion.
use super::*;
mod cleanup;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::{name}"
    ))
}
fn create(fixture: &Fixture, connection: &WorkerLaunchConnection) -> CreatedLaptop {
    let (nix, plan, _request, phone) = fixture.resources();
    let runtime = fixture.runtime();
    let workflow = runtime
        .retain_laptop_network_for_connection(&nix, plan, phone, connection)
        .unwrap_or_else(|error| panic!("{}", error.cause()));
    assert_eq!(
        runtime.run_laptop_network(&workflow, end()).unwrap(),
        LaptopNetworkProgress::Ready
    );
    let telemetry = CommandTelemetry::capture(runtime, &fixture.source).unwrap();
    let LaptopCreation::Created(created) =
        runtime.create_laptop(&workflow, &telemetry, end()).unwrap()
    else {
        panic!("actual create")
    };
    created
}
fn ready(
    fixture: &Fixture,
    connection: &WorkerLaunchConnection,
) -> (CreatedLaptop, NixReleasedPane) {
    let created = create(fixture, connection);
    let runtime = fixture.runtime();
    runtime.publish_laptop_launch(&created).unwrap();
    let ContainerStart::Started(started) = runtime.start_laptop_container(&created, end()).unwrap()
    else {
        panic!("actual start")
    };
    let MemoryConfiguration::Configured(memory) = runtime
        .configure_started_laptop_memory(&started, end())
        .unwrap()
    else {
        panic!("actual absent memory")
    };
    let ColdCommit::Committed(cold) = runtime.commit_started_laptop_cold(&memory, end()).unwrap()
    else {
        panic!("actual cold commit")
    };
    let PaneStart::Started(pane) = runtime.start_laptop_pane(&cold, end()).unwrap() else {
        panic!("actual pane")
    };
    let NixGuardRelease::Released(released) =
        runtime.release_laptop_nix_guard(&pane, end()).unwrap()
    else {
        panic!("actual guard close")
    };
    (created, released)
}
#[test]
fn original_j_borrow_keeps_same_record_and_real_lease_while_named_operations_run() {
    if isolated("original_j_borrow_keeps_same_record_and_real_lease_while_named_operations_run") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
    let (created, released) = ready(&fixture, &connection);
    let paths = {
        let mut borrowed = runtime
            .borrow_started_laptop_storage(&created, &connection)
            .unwrap();
        borrowed.assert_binding(&fixture.source, &sid()).unwrap();
        borrowed.check_resource_current().unwrap();
        borrowed.require_no_cold_pending().unwrap();
        borrowed.prepare_cold_launch_storage().unwrap();
        borrowed.prepare_runtime_directory().unwrap();
        borrowed.record_storage_binding().unwrap();
        let receipt = borrowed.observe_launch_receipt().unwrap();
        assert!(!receipt.exists());
        assert!(
            runtime
                .start_laptop_viewer_session(&released, end())
                .is_err()
        );
        assert!(!fixture.root.join("viewer-ready").exists());
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        borrowed.paths().clone()
    };
    assert_eq!(
        &paths,
        runtime
            .borrow_started_laptop_storage(&created, &connection)
            .unwrap()
            .paths()
    );
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    assert!(runtime.close(end()).is_err());
}
#[test]
fn later_j_requires_both_actual_socket_close_and_explicit_original_hold_release() {
    if isolated("later_j_requires_both_actual_socket_close_and_explicit_original_hold_release") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_old_client, original, mut old_hold) = accepted(&fixture, &service, "original");
    let (created, _released) = ready(&fixture, &original);
    let (_new_client, next, mut next_hold) = accepted(&fixture, &service, "later");
    assert!(
        runtime
            .borrow_started_laptop_storage(&created, &next)
            .is_err()
    );
    assert!(
        runtime
            .borrow_started_laptop_source_storage(&created)
            .is_err()
    );
    original.close_socket(end()).unwrap();
    assert!(
        runtime
            .borrow_started_laptop_storage(&created, &next)
            .is_err()
    );
    assert!(
        runtime
            .borrow_started_laptop_source_storage(&created)
            .is_err()
    );
    old_hold.release(end()).unwrap();
    let borrowed = runtime
        .borrow_started_laptop_storage(&created, &next)
        .unwrap();
    borrowed.assert_binding(&fixture.source, &sid()).unwrap();
    drop(borrowed);
    runtime
        .borrow_started_laptop_source_storage(&created)
        .unwrap()
        .check_resource_current()
        .unwrap();
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    next.close_socket(end()).unwrap();
    next_hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn physical_socket_and_hold_release_cannot_replace_actual_old_viewer_cleanup() {
    if isolated("physical_socket_and_hold_release_cannot_replace_actual_old_viewer_cleanup") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_old_client, original, mut old_hold) = accepted(&fixture, &service, "original");
    let (created, released) = ready(&fixture, &original);
    let ViewerStart::Started(viewer) = runtime
        .start_laptop_viewer_session(&released, end())
        .unwrap()
    else {
        panic!("actual old viewer")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    let (_new_client, next, mut next_hold) = accepted(&fixture, &service, "later");
    original.close_socket(end()).unwrap();
    old_hold.release(end()).unwrap();
    assert!(
        runtime
            .borrow_started_laptop_storage(&created, &next)
            .is_err()
    );
    assert!(
        runtime
            .borrow_started_laptop_source_storage(&created)
            .is_err()
    );
    runtime.close_laptop_viewer(&viewer, end()).unwrap();
    runtime
        .borrow_started_laptop_storage(&created, &next)
        .unwrap()
        .check_resource_current()
        .unwrap();
    next.close_socket(end()).unwrap();
    next_hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn another_service_on_same_runtime_cannot_borrow_a_released_created_resource() {
    if isolated("another_service_on_same_runtime_cannot_borrow_a_released_created_resource") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, original, mut hold) = accepted(&fixture, &service, "original");
    let (created, _released) = ready(&fixture, &original);
    original.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    let other = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_foreign_client, foreign, mut foreign_hold) =
        accepted(&fixture, &other, "foreign service");
    let error = runtime
        .borrow_started_laptop_storage(&created, &foreign)
        .err()
        .unwrap();
    assert_eq!(error.code(), "WORKER_STARTED_CONNECTION_SERVICE_CHANGED");
    foreign.close_socket(end()).unwrap();
    foreign_hold.release(end()).unwrap();
    other.close(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn cleanup_receipt_uses_actual_selected_nonce_during_retained_start_not_runtime_json() {
    if isolated("cleanup_receipt_uses_actual_selected_nonce_during_retained_start_not_runtime_json")
    {
        return;
    }
    let fixture = Fixture::employee("created-start-nonzero");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
    let created = create(&fixture, &connection);
    assert!(
        !runtime
            .observe_created_laptop_receipt(&created)
            .unwrap()
            .is_file()
    );
    runtime.publish_laptop_launch(&created).unwrap();
    let metadata = fixture.root.join("state").join(SID).join("runtime.json");
    let raw: serde_json::Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    let home = created
        .workflow
        .record
        .lock()
        .unwrap()
        .resources()
        .storage()
        .paths()
        .home()
        .to_owned();
    let selected = home
        .join(".reverie-launch")
        .join(raw["exit"].as_str().unwrap());
    assert!(matches!(
        runtime.start_laptop_container(&created, end()).unwrap(),
        ContainerStart::Retained
    ));
    let foreign = fixture.root.join("foreign.exit");
    fs::write(&foreign, b"0").unwrap();
    fs::write(
        metadata,
        serde_json::to_vec(&json!({"exit":foreign})).unwrap(),
    )
    .unwrap();
    let observed = runtime.observe_created_laptop_receipt(&created).unwrap();
    assert!(observed.same_workflow(&created.workflow));
    assert!(!observed.is_file());
    fs::write(selected, b"malformed integer remains a completion file").unwrap();
    assert!(
        runtime
            .observe_created_laptop_receipt(&created)
            .unwrap()
            .is_file()
    );
    assert!(
        runtime
            .borrow_started_laptop_storage(&created, &connection)
            .is_err()
    );
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
