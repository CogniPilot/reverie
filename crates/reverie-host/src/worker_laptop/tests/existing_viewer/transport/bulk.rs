use super::*;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::bulk::{name}"
    ))
}
fn output(client: &mut UnixStream) -> Vec<u8> {
    let mut output = Vec::new();
    loop {
        let (kind, bytes) = receive(client);
        if kind == b'X' {
            assert_eq!(bytes, b"7");
            return output;
        }
        assert_eq!(kind, b'O');
        assert!(bytes.len() <= 65536);
        output.extend(bytes);
    }
}
#[test]
fn raw_binary_output_stays_chunked_and_all_queued_bytes_precede_exit() {
    if isolated("raw_binary_output_stays_chunked_and_all_queued_bytes_precede_exit") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-output-bulk");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
    let existing = retained(&fixture, &connection);
    let viewer = started(&fixture, &existing, &connection);
    let relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    let (reason, bytes) = std::thread::scope(|scope| {
        let worker = scope.spawn(|| run(relay, &fixture));
        let bytes = output(&mut client);
        (worker.join().unwrap(), bytes)
    });
    cleanup_component(&fixture, &existing, connection, hold, &service);
    assert!(matches!(reason, ViewerRelayEnd::ViewerExited(7)));
    assert_eq!(
        bytes,
        (0..196608).map(|n| (n % 256) as u8).collect::<Vec<_>>()
    );
}
#[test]
fn maximum_input_frame_survives_real_pty_backpressure_before_the_owned_child_reads() {
    if isolated("maximum_input_frame_survives_real_pty_backpressure_before_the_owned_child_reads") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-input-bulk");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
    let existing = retained(&fixture, &connection);
    let viewer = started(&fixture, &existing, &connection);
    let relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    let pressure = Arc::new(crate::captured_client::test_hooks::Gate::default());
    let bytes = (0..262144).map(|n| (n % 256) as u8).collect::<Vec<_>>();
    let reason = std::thread::scope(|scope| {
        let observed = pressure.clone();
        let worker = scope.spawn(|| {
            crate::worker_reports::terminal::test_hooks::observe_backpressure(observed);
            run(relay, &fixture)
        });
        send(&mut client, b'I', &bytes);
        wait(|| pressure.entered.load(Ordering::Acquire));
        assert!(!fixture.root.join("viewer-input").exists());
        fs::write(
            fixture.root.join("release-viewer-read"),
            b"own child may now read",
        )
        .unwrap();
        assert_eq!(output(&mut client), b"BULK");
        worker.join().unwrap()
    });
    cleanup_component(&fixture, &existing, connection, hold, &service);
    assert!(matches!(reason, ViewerRelayEnd::ViewerExited(7)));
    assert_eq!(fs::read(fixture.root.join("viewer-input")).unwrap(), bytes);
}
