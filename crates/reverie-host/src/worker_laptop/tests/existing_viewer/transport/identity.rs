use super::*;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::identity::{name}"
    ))
}
#[test]
fn retired_original_j_and_same_sid_replacement_cannot_restart_or_rebrand_held_owner() {
    if isolated("retired_original_j_and_same_sid_replacement_cannot_restart_or_rebrand_held_owner")
    {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (_client, old, mut hold) = accepted(&fixture, &service, "opencode");
    let existing = retained(&fixture, &old);
    old.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    let (_new_client, new, mut new_hold) = accepted(&fixture, &service, "opencode");
    assert!(!old.same_connection(&new));
    for connection in [&old, &new] {
        assert!(
            fixture
                .runtime()
                .start_existing_viewer_for_connection(&existing, connection, end())
                .is_err()
        );
    }
    assert!(!fixture.root.join("viewer-ready").exists());
    let (storage, _, _, _, _, _) = fixture
        .runtime()
        .reclaim_existing_relay(&existing)
        .unwrap()
        .into_parts();
    new.close_socket(end()).unwrap();
    new_hold.release(end()).unwrap();
    service.close(end()).unwrap();
    storage.close(end()).unwrap();
}
#[test]
fn released_connection_and_lost_service_keep_real_box_without_retrofit_or_constructor() {
    if isolated(
        "released_connection_and_lost_service_keep_real_box_without_retrofit_or_constructor",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let weak = Arc::downgrade(&service);
    let (_client, connection, mut hold) = accepted(&fixture, &service, "opencode");
    let existing = retained(&fixture, &connection);
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    drop(connection);
    drop(hold);
    drop(service);
    assert!(
        weak.upgrade().is_none(),
        "job source weak link cannot cycle service"
    );
    assert!(
        fixture
            .runtime()
            .start_existing_viewer(&existing, end())
            .is_err()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    let (storage, _, _, _, _, _) = fixture
        .runtime()
        .reclaim_existing_relay(&existing)
        .unwrap()
        .into_parts();
    storage.close(end()).unwrap();
}
