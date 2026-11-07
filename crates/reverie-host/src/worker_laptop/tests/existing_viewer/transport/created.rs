//! Original J is retained BEFORE network/create and survives the real guard
//! sum transition. No post-create request/nonce/CID can retrofit this brand.
use super::*;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::created::{name}"
    ))
}
#[test]
fn original_j_brand_moves_through_actual_created_chain_and_guard_close_into_same_native_relay() {
    if isolated(
        "original_j_brand_moves_through_actual_created_chain_and_guard_close_into_same_native_relay",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, mut hold) = accepted(&fixture, &service, "original-command");
    let (nix, plan, _request, phone) = fixture.resources();
    let runtime = fixture.runtime();
    let workflow = runtime
        .retain_laptop_network_for_connection(&nix, plan, phone, &connection)
        .unwrap_or_else(|e| panic!("{}", e.cause()));
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
        panic!("actual consumed guard")
    };
    let ViewerStart::Started(viewer) = runtime
        .start_laptop_viewer_session(&released, end())
        .unwrap()
    else {
        panic!("actual viewer")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    let relay = connection.begin_viewer_relay(runtime, &viewer).unwrap();
    let reason = std::thread::scope(|scope| {
        let worker = scope.spawn(|| run(relay, &fixture));
        send(&mut client, b'I', b"Q");
        assert_eq!(receive(&mut client), (b'X', b"7".to_vec()));
        worker.join().unwrap()
    });
    assert!(matches!(reason, ViewerRelayEnd::ViewerExited(7)));
    assert!(runtime.reclaim_laptop_network(workflow.clone()).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    // Explicit native-component teardown only. Created/storage custody remains
    // in the real record; no App finalizer/global release is claimed.
    runtime.close_laptop_viewer(&viewer, end()).unwrap();
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    assert!(runtime.close(end()).is_err());
}
#[test]
fn foreign_original_j_refuses_before_nix_transfer_and_returns_actual_office_and_plan() {
    if isolated("foreign_original_j_refuses_before_nix_transfer_and_returns_actual_office_and_plan")
    {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let other = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(other.runtime()));
    let (_client, connection, mut hold) = accepted(&other, &service, "opencode");
    let (nix, plan, _request, phone) = fixture.resources();
    let error = fixture
        .runtime()
        .retain_laptop_network_for_connection(&nix, plan, phone, &connection)
        .err()
        .unwrap();
    let (plan, request, phone, cause) = error.into_parts();
    assert_eq!(cause.code(), "VIEWER_CONNECTION_RUNTIME_CHANGED");
    assert_eq!(request.session(), plan.session());
    phone
        .assert_runtime_session(fixture.runtime(), plan.session())
        .unwrap();
    assert!(
        fixture
            .runtime()
            .laptop_workflows()
            .records
            .lock()
            .unwrap()
            .is_empty()
    );
    let returned = fixture
        .runtime()
        .reclaim_nix_store(nix)
        .unwrap_or_else(|_| panic!("actual original Nix owner remains"));
    let (guard, storage, outcome) = returned.into_parts();
    outcome.unwrap();
    fixture.office.close_phone(&phone, end()).unwrap();
    guard.close().unwrap();
    storage.close(end()).unwrap();
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    assert!(!fixture.root.join("created-network").exists());
    assert!(!fixture.root.join("created-laptop").exists());
}
