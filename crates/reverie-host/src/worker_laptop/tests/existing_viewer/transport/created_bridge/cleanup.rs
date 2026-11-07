use super::*;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::cleanup::{name}"
    ))
}
#[test]
fn cached_guard_and_absent_viewer_cleanup_fence_old_pane_without_global_stop_or_socket_close() {
    if isolated(
        "cached_guard_and_absent_viewer_cleanup_fence_old_pane_without_global_stop_or_socket_close",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
    let (created, released) = ready(&fixture, &connection);
    assert!(!runtime.cancellation().is_cancelled());
    runtime
        .cleanup_created_laptop_nix_guard_for_worker(&created, &connection)
        .unwrap();
    runtime
        .close_created_laptop_viewer(&created, end())
        .unwrap();
    let attempted = runtime.start_laptop_viewer_session(&released, end());
    let unexpected = if let Ok(ViewerStart::Started(viewer)) = attempted {
        runtime.close_laptop_viewer(&viewer, end()).unwrap();
        true
    } else {
        false
    };
    let old_borrow_denied = runtime
        .borrow_started_laptop_storage(&created, &connection)
        .is_err();
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    let (_later_client, later, mut later_hold) = accepted(&fixture, &service, "later");
    runtime
        .borrow_started_laptop_storage(&created, &later)
        .unwrap()
        .check_resource_current()
        .unwrap();
    later.close_socket(end()).unwrap();
    later_hold.release(end()).unwrap();
    service.close(end()).unwrap();
    assert!(
        !unexpected,
        "terminal cached cleanup must prevent a new real viewer"
    );
    assert!(old_borrow_denied);
    assert!(!fixture.root.join("viewer-ready").exists());
}
#[test]
fn before_pane_cleanup_closes_real_held_guard_without_fabricating_a_pane_or_releasing_storage() {
    if isolated(
        "before_pane_cleanup_closes_real_held_guard_without_fabricating_a_pane_or_releasing_storage",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
    let created = create(&fixture, &connection);
    assert!(crate::worker_nix::NixStoreGuard::acquire_launch(&fixture.source, &sid()).is_err());
    runtime
        .cleanup_created_laptop_nix_guard_for_worker(&created, &connection)
        .unwrap();
    crate::worker_nix::NixStoreGuard::acquire_launch(&fixture.source, &sid())
        .unwrap()
        .close()
        .unwrap();
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(runtime.start_laptop_container(&created, end()).is_err());
    assert!(!fixture.root.join("started-laptop").exists());
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn worker_created_stop_has_no_component_body_cap_and_accepts_only_its_original_closed_j() {
    if isolated(
        "worker_created_stop_has_no_component_body_cap_and_accepts_only_its_original_closed_j",
    ) {
        return;
    }
    for worker in [false, true] {
        let fixture = Fixture::employee("created-viewer-echo");
        let runtime = fixture.runtime();
        let service = Arc::new(WorkerReportService::from_runtime(runtime));
        let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
        let (created, _released) = ready(&fixture, &connection);
        let (_foreign_client, foreign, mut foreign_hold) = accepted(&fixture, &service, "foreign");
        assert!(
            runtime
                .stop_created_laptop_for_worker(&created, &foreign)
                .is_err()
        );
        assert!(!fixture.root.join("stopped-laptop").exists());
        foreign.close_socket(end()).unwrap();
        foreign_hold.release(end()).unwrap();
        fs::write(
            fixture.root.join("created-cleanup-query-delay"),
            b"actual fixed80ms calls",
        )
        .unwrap();
        connection.close_socket(end()).unwrap();
        let result = if worker {
            runtime.stop_created_laptop_for_worker(&created, &connection)
        } else {
            runtime.stop_created_laptop(&created, Instant::now() + Duration::from_millis(120))
        };
        assert_eq!(matches!(result, Ok(CreatedCleanup::Stopped(_))), worker);
        assert!(fixture.root.join("stopped-laptop").exists());
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        hold.release(end()).unwrap();
        service.close(end()).unwrap();
    }
}
#[test]
fn noncanonical_successful_create_keeps_actual_resources_without_by_name_stop_or_fake_identity() {
    if isolated(
        "noncanonical_successful_create_keeps_actual_resources_without_by_name_stop_or_fake_identity",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-noncanonical");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
    let created = create(&fixture, &connection);
    assert!(created.container_id().is_none());
    runtime
        .cleanup_created_laptop_nix_guard_for_worker(&created, &connection)
        .unwrap();
    assert!(
        runtime
            .stop_created_laptop_for_worker(&created, &connection)
            .is_err()
    );
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert!(
        !trace
            .lines()
            .any(|line| line.starts_with("stop\0") || line.starts_with("kill\0"))
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(runtime.close(end()).is_err());
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
