use super::*;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::receipt::{name}"
    ))
}
fn write_receipt(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
#[test]
fn receipt_wins_over_exited_child_after_original_grace_and_last_output_precedes_x() {
    if isolated("receipt_wins_over_exited_child_after_original_grace_and_last_output_precedes_x") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-exit");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
    let (existing, path) = retained_with_path(&fixture, &connection);
    write_receipt(&path, "  -١٢٣_٤٥٦\n".as_bytes());
    let viewer = started(&fixture, &existing, &connection);
    let relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    let began = Instant::now();
    let reason = std::thread::scope(|scope| {
        let worker = scope.spawn(|| run(relay, &fixture));
        let mut output = Vec::new();
        loop {
            let (kind, bytes) = receive(&mut client);
            if kind == b'X' {
                assert_eq!(bytes, b"-123456");
                break;
            }
            assert_eq!(kind, b'O');
            output.extend(bytes);
        }
        assert_eq!(output, b"LAST");
        worker.join().unwrap()
    });
    assert!(began.elapsed() >= Duration::from_millis(500));
    assert!(matches!(reason,ViewerRelayEnd::Receipt(bytes) if bytes==b"-123456"));
    assert!(
        fixture
            .runtime()
            .observe_existing_viewer_receipt(&existing)
            .unwrap()
            .is_file()
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    cleanup_component(&fixture, &existing, connection, hold, &service);
}
#[test]
fn malformed_receipt_emits_e_without_x_or_native_storage_cleanup() {
    if isolated("malformed_receipt_emits_e_without_x_or_native_storage_cleanup") {
        return;
    }
    for bytes in [b"not-an-integer".as_slice(), b"1\xff".as_slice()] {
        let fixture = Fixture::employee("created-viewer-echo");
        let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
        let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
        let (existing, path) = retained_with_path(&fixture, &connection);
        write_receipt(&path, bytes);
        let viewer = started(&fixture, &existing, &connection);
        let mut relay = connection
            .begin_viewer_relay(fixture.runtime(), &viewer)
            .unwrap();
        assert!(relay.step().is_err());
        assert_eq!(receive(&mut client).0, b'E');
        assert!(
            relay.step().is_err(),
            "terminal transport failure cannot replay"
        );
        assert!(
            fixture
                .runtime()
                .laptop_viewer_status(&viewer)
                .unwrap()
                .is_none()
        );
        assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
        assert!(
            fixture
                .runtime()
                .observe_existing_viewer_receipt(&existing)
                .unwrap()
                .is_file()
        );
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        cleanup_component(&fixture, &existing, connection, hold, &service);
    }
}
#[test]
fn eof_returns_with_live_viewer_and_later_fresh_receipt_is_still_observable_before_finalizer() {
    if isolated(
        "eof_returns_with_live_viewer_and_later_fresh_receipt_is_still_observable_before_finalizer",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (client, connection, hold) = accepted(&fixture, &service, "opencode");
    let (existing, path) = retained_with_path(&fixture, &connection);
    let viewer = started(&fixture, &existing, &connection);
    let relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    client.shutdown(std::net::Shutdown::Write).unwrap();
    assert!(matches!(run(relay, &fixture), ViewerRelayEnd::PeerClosed));
    assert!(
        !fixture
            .runtime()
            .observe_existing_viewer_receipt(&existing)
            .unwrap()
            .is_file()
    );
    write_receipt(&path, b"0");
    assert!(
        fixture
            .runtime()
            .observe_existing_viewer_receipt(&existing)
            .unwrap()
            .is_file()
    );
    assert!(
        fixture
            .runtime()
            .laptop_viewer_status(&viewer)
            .unwrap()
            .is_none()
    );
    assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
    cleanup_component(&fixture, &existing, connection, hold, &service);
}
