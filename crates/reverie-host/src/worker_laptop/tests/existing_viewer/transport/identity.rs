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
#[test]
fn original_j_close_during_selected_constructor_retains_late_child_and_same_box_until_checked_close()
 {
    if isolated(
        "original_j_close_during_selected_constructor_retains_late_child_and_same_box_until_checked_close",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (client, connection, mut hold) = accepted(&fixture, &service, "opencode");
    let existing = Arc::new(retained(&fixture, &connection));
    let connection = Arc::new(connection);
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    struct Release(Arc<crate::captured_client::test_hooks::Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.released.store(true, Ordering::Release);
        }
    }
    let release = Release(gate.clone());
    let runtime = fixture.runtime().clone();
    let original = connection.clone();
    let selected = existing.clone();
    let pause = gate.clone();
    let constructor = std::thread::spawn(move || {
        crate::worker_laptop::viewer::test_hooks::next_constructor(pause);
        runtime.start_existing_viewer_for_connection(&selected, &original, end())
    });
    wait(|| gate.entered.load(Ordering::Acquire));
    connection.close_socket(end()).unwrap();
    drop(client);
    gate.released.store(true, Ordering::Release);
    assert!(matches!(
        constructor.join().unwrap().unwrap(),
        ExistingViewerStart::Retained
    ));
    wait(|| fixture.root.join("viewer-ready").is_file());
    assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    let (storage, _, _, _, _, failure) = fixture
        .runtime()
        .reclaim_existing_relay(&existing)
        .unwrap()
        .into_parts();
    assert!(
        failure.is_some(),
        "original failed handoff remains distinct from native cleanup"
    );
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    storage.close(end()).unwrap();
    drop(release);
}
