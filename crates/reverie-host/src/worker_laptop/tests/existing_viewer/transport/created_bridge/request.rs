//! Exact owned request file and real runtime/exit preservation. No live engine.
use super::*;
use crate::worker_laptop::publication::test_hooks as request_hooks;
use std::os::unix::fs::symlink;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::request::{name}"
    ))
}
fn selected(created: &CreatedLaptop) -> PathBuf {
    created
        .workflow
        .record
        .lock()
        .unwrap()
        .creation
        .as_ref()
        .unwrap()
        .publication
        .as_ref()
        .unwrap()
        .selected_exit()
        .unwrap()
        .with_extension("json")
}
fn finish_j(
    service: &WorkerReportService,
    connection: WorkerLaunchConnection,
    mut hold: WorkerLaunchHold,
) {
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn unissued_request_unlinks_once_and_keeps_runtime_exit_and_later_foreign_leaf() {
    if isolated("unissued_request_unlinks_once_and_keeps_runtime_exit_and_later_foreign_leaf") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, hold) = accepted(&fixture, &service, "original");
    let created = create(&fixture, &connection);
    runtime.publish_laptop_launch(&created).unwrap();
    let request = selected(&created);
    let exit = request.with_extension("exit");
    let metadata = fixture.root.join("state").join(SID).join("runtime.json");
    let original = fs::read(&metadata).unwrap();
    fs::write(&exit, b"existing exit bytes").unwrap();
    runtime
        .cleanup_created_laptop_nix_guard_for_worker(&created, &connection)
        .unwrap();
    runtime.cleanup_created_laptop_request(&created).unwrap();
    assert!(!request.exists());
    assert_eq!(fs::read(&metadata).unwrap(), original);
    assert_eq!(fs::read(&exit).unwrap(), b"existing exit bytes");
    assert!(runtime.start_laptop_container(&created, end()).is_err());
    fs::write(&request, b"foreign replacement after completed unlink").unwrap();
    runtime.cleanup_created_laptop_request(&created).unwrap();
    assert_eq!(
        fs::read(&request).unwrap(),
        b"foreign replacement after completed unlink"
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    finish_j(&service, connection, hold);
}
#[test]
fn started_request_is_kept_and_readonly_custody_is_checked_closed() {
    if isolated("started_request_is_kept_and_readonly_custody_is_checked_closed") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, hold) = accepted(&fixture, &service, "original");
    let (created, released) = ready(&fixture, &connection);
    let request = selected(&created);
    let before = fs::read(&request).unwrap();
    runtime.cleanup_created_laptop_request(&created).unwrap();
    assert_eq!(fs::read(&request).unwrap(), before);
    assert!(
        runtime
            .start_laptop_viewer_session(&released, end())
            .is_err()
    );
    created
        .workflow
        .record
        .lock()
        .unwrap()
        .creation
        .as_ref()
        .unwrap()
        .publication
        .as_ref()
        .unwrap()
        .require_native_closed()
        .unwrap();
    finish_j(&service, connection, hold);
}
#[test]
fn changed_or_hardlinked_request_is_not_removed_and_failed_cleanup_never_replays() {
    if isolated("changed_or_hardlinked_request_is_not_removed_and_failed_cleanup_never_replays") {
        return;
    }
    for kind in 0..3 {
        let fixture = Fixture::employee("created-viewer-echo");
        let runtime = fixture.runtime();
        let service = Arc::new(WorkerReportService::from_runtime(runtime));
        let (_client, connection, hold) = accepted(&fixture, &service, "original");
        let created = create(&fixture, &connection);
        runtime.publish_laptop_launch(&created).unwrap();
        let request = selected(&created);
        let saved = fixture.root.join("saved-request");
        let raw = fs::read(&request).unwrap();
        let foreign = fixture.root.join("foreign");
        fs::write(&foreign, b"foreign bytes").unwrap();
        if kind == 2 {
            fs::hard_link(&request, &saved).unwrap();
        } else {
            fs::rename(&request, &saved).unwrap();
            if kind == 0 {
                fs::write(&request, b"foreign replacement").unwrap();
            } else {
                symlink(&foreign, &request).unwrap();
            }
        }
        runtime
            .cleanup_created_laptop_nix_guard_for_worker(&created, &connection)
            .unwrap();
        assert!(runtime.cleanup_created_laptop_request(&created).is_err());
        assert!(runtime.cleanup_created_laptop_request(&created).is_err());
        assert!(request.symlink_metadata().is_ok());
        assert_eq!(fs::read(&saved).unwrap(), raw);
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign bytes");
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        finish_j(&service, connection, hold);
    }
}
#[test]
fn known_partial_publication_removes_only_owned_request_and_preserves_foreign_metadata() {
    if isolated(
        "known_partial_publication_removes_only_owned_request_and_preserves_foreign_metadata",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, hold) = accepted(&fixture, &service, "original");
    let created = create(&fixture, &connection);
    let foreign = fixture.root.join("foreign-metadata");
    fs::write(&foreign, b"untouched").unwrap();
    let metadata = fixture.root.join("state").join(SID).join("runtime.json");
    symlink(&foreign, &metadata).unwrap();
    assert!(runtime.publish_laptop_launch(&created).is_err());
    let request = selected(&created);
    assert!(request.exists());
    runtime
        .cleanup_created_laptop_nix_guard_for_worker(&created, &connection)
        .unwrap();
    runtime.cleanup_created_laptop_request(&created).unwrap();
    assert!(!request.exists());
    assert_eq!(fs::read(&foreign).unwrap(), b"untouched");
    assert!(metadata.symlink_metadata().unwrap().is_symlink());
    finish_j(&service, connection, hold);
}
#[test]
fn failed_actual_request_anchor_close_retains_resources_and_does_not_repeat_unlink() {
    if isolated("failed_actual_request_anchor_close_retains_resources_and_does_not_repeat_unlink") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, hold) = accepted(&fixture, &service, "original");
    let created = create(&fixture, &connection);
    runtime.publish_laptop_launch(&created).unwrap();
    let request = selected(&created);
    runtime
        .cleanup_created_laptop_nix_guard_for_worker(&created, &connection)
        .unwrap();
    request_hooks::refuse_close(1);
    assert!(runtime.cleanup_created_laptop_request(&created).is_err());
    assert!(!request.exists());
    fs::write(&request, b"foreign later leaf").unwrap();
    request_hooks::refuse_close(1);
    assert!(runtime.cleanup_created_laptop_request(&created).is_err());
    assert_eq!(request_hooks::count(), 0);
    assert_eq!(fs::read(&request).unwrap(), b"foreign later leaf");
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    finish_j(&service, connection, hold);
}
#[test]
fn unknown_actual_start_keeps_request_and_selected_nonce_for_reconciliation() {
    if isolated("unknown_actual_start_keeps_request_and_selected_nonce_for_reconciliation") {
        return;
    }
    struct Release(PathBuf);
    impl Drop for Release {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, b"owned release");
        }
    }
    let fixture = Fixture::employee("created-start-pending");
    let runtime = fixture.runtime();
    let _release = Release(fixture.root.join("release-laptop-start"));
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, hold) = accepted(&fixture, &service, "original");
    let created = create(&fixture, &connection);
    runtime.publish_laptop_launch(&created).unwrap();
    let request = selected(&created);
    let original = fs::read(&request).unwrap();
    assert!(matches!(
        runtime
            .start_laptop_container(&created, Instant::now() + Duration::from_secs(1))
            .unwrap(),
        ContainerStart::Retained
    ));
    let actual_effect = fixture.root.join("laptop-start-entered").is_file();
    runtime
        .cleanup_created_laptop_nix_guard_for_worker(&created, &connection)
        .unwrap();
    let refused = runtime.cleanup_created_laptop_request(&created).is_err();
    fs::write(fixture.root.join("release-laptop-start"), b"owned release").unwrap();
    assert!(
        actual_effect,
        "must observe the actual started client before its lost reply"
    );
    assert!(refused);
    assert_eq!(fs::read(&request).unwrap(), original);
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    connection.close_socket(end()).unwrap();
    assert!(
        service.close(end()).is_err(),
        "actual unknown resource keeps logical Hold counted"
    );
    drop(hold);
}
