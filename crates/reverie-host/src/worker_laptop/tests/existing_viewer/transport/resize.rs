//! Actual fixed metadata queries, viewer marker, native WINCH and original
//! resize observation interval. Guest client PID is DATA, never a host signal.
use super::*;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::resize::{name}"
    ))
}
fn canonical(fixture: &Fixture, connection: &WorkerLaunchConnection) -> ExistingViewer {
    canonical_with_path(fixture, connection).0
}
fn canonical_with_path(
    fixture: &Fixture,
    connection: &WorkerLaunchConnection,
) -> (ExistingViewer, PathBuf) {
    let (mut storage, plan, _request, inspection) = originals_with_id(fixture, &"c".repeat(64));
    let receipt = super::super::relay::receipt(fixture, &mut storage);
    let path = crate::native::python_path(&receipt.exit_path_data().codepoints()).unwrap();
    fs::write(
        fixture.root.join("relay-query-control"),
        b"owned closed query fixture",
    )
    .unwrap();
    fs::write(fixture.root.join("relay-clients.out"), b"123 100 35\n").unwrap();
    fs::write(fixture.root.join("relay-pane.out"), b"0\n").unwrap();
    let existing = fixture
        .runtime()
        .retain_existing_relay_for_connection(storage, plan, inspection, receipt, connection)
        .unwrap_or_else(|e| panic!("{}", e.cause()));
    (existing, path)
}
#[test]
fn actual_dead_pane_evidence_is_refused_unless_fresh_receipt_appeared_after_loop_observation() {
    if isolated(
        "actual_dead_pane_evidence_is_refused_unless_fresh_receipt_appeared_after_loop_observation",
    ) {
        return;
    }
    for completed in [false, true] {
        let fixture = Fixture::employee("created-viewer-echo");
        let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
        let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
        let (existing, path) = canonical_with_path(&fixture, &connection);
        fs::write(fixture.root.join("relay-pane.out"), b"1\n").unwrap();
        let viewer = started(&fixture, &existing, &connection);
        let mut relay = connection
            .begin_viewer_relay(fixture.runtime(), &viewer)
            .unwrap();
        loop {
            match relay.step().unwrap() {
                ViewerRelayEvent::Progress => {}
                ViewerRelayEvent::CheckCurrentIntent => break,
                ViewerRelayEvent::Ended(_) => panic!("no completion before periodic observation"),
            }
        }
        if completed {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"0").unwrap();
        }
        let observed = relay.check_current_intent(&fixture.source);
        if completed {
            assert!(matches!(observed.unwrap(), ViewerRelayEvent::Progress));
            assert!(
                matches!(relay.step().unwrap(),ViewerRelayEvent::Ended(ViewerRelayEnd::Receipt(bytes)) if bytes==b"0")
            );
            assert_eq!(receive(&mut client), (b'X', b"0".to_vec()));
        } else {
            assert!(matches!(
                observed,
                Err(crate::worker_reports::ViewerRelayError::PaneDead)
            ));
            assert_eq!(receive(&mut client).0, b'E');
        }
        assert!(
            fixture
                .runtime()
                .laptop_viewer_status(&viewer)
                .unwrap()
                .is_none()
        );
        cleanup_component(&fixture, &existing, connection, hold, &service);
    }
}
#[test]
fn resize_confirms_only_exact_marker_and_size_then_stops_querying_that_request() {
    if isolated("resize_confirms_only_exact_marker_and_size_then_stops_querying_that_request") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
    let existing = canonical(&fixture, &connection);
    let viewer = started(&fixture, &existing, &connection);
    let mut relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    send(&mut client, b'R', b"[100,35]");
    assert!(matches!(relay.step().unwrap(), ViewerRelayEvent::Progress));
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert_eq!(
        trace
            .lines()
            .filter(|line| line.contains("list-clients"))
            .count(),
        1
    );
    assert_eq!(
        trace
            .lines()
            .filter(|line| line.ends_with("/proc/123/environ"))
            .count(),
        1
    );
    std::thread::sleep(Duration::from_millis(260));
    finish_observation(relay, &fixture, &mut client, 1);
    cleanup_component(&fixture, &existing, connection, hold, &service);
}
#[test]
fn unread_environment_cannot_acknowledge_size_and_actual_request_is_observed_again() {
    if isolated("unread_environment_cannot_acknowledge_size_and_actual_request_is_observed_again") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
    let existing = canonical(&fixture, &connection);
    fs::write(
        fixture.root.join("relay-unread-environ"),
        b"owned failed env read",
    )
    .unwrap();
    let viewer = started(&fixture, &existing, &connection);
    let mut relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    send(&mut client, b'R', b"[100,35]");
    relay.step().unwrap();
    fs::remove_file(fixture.root.join("relay-unread-environ")).unwrap();
    std::thread::sleep(Duration::from_millis(260));
    finish_observation(relay, &fixture, &mut client, 2);
    cleanup_component(&fixture, &existing, connection, hold, &service);
}

fn finish_observation(
    relay: ViewerRelay<'_>,
    fixture: &Fixture,
    client: &mut UnixStream,
    expected: usize,
) {
    let reason = std::thread::scope(|scope| {
        let task = scope.spawn(|| run(relay, fixture));
        send(client, b'I', b"W");
        let (kind, bytes) = receive(client);
        assert_eq!(kind, b'O');
        assert!(String::from_utf8(bytes).unwrap().starts_with("WINCH="));
        let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
        assert_eq!(
            trace
                .lines()
                .filter(|line| line.contains("list-clients"))
                .count(),
            expected
        );
        send(client, b'I', b"Q");
        assert_eq!(receive(client), (b'X', b"7".to_vec()));
        task.join().unwrap()
    });
    assert!(matches!(reason, ViewerRelayEnd::ViewerExited(7)));
}
#[test]
fn unknown_exact_resize_constructor_remains_retained_and_blocks_later_confirmation_after_settlement()
 {
    if isolated(
        "unknown_exact_resize_constructor_remains_retained_and_blocks_later_confirmation_after_settlement",
    ) {
        return;
    }
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    gate.released.store(true, Ordering::Release);
    let hooks = crate::captured_client::test_hooks::Hooks {
        gate: Some(gate.clone()),
        ..Default::default()
    };
    let starts = hooks.starts.clone();
    let fixture = Fixture::employee_with_hooks("created-viewer-echo", hooks);
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
    let existing = canonical(&fixture, &connection);
    let viewer = started(&fixture, &existing, &connection);
    let mut relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    struct Release(Arc<crate::captured_client::test_hooks::Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.released.store(true, Ordering::Release);
        }
    }
    let release = Release(gate.clone());
    let before = starts.load(Ordering::Acquire);
    gate.entered.store(false, Ordering::Release);
    gate.released.store(false, Ordering::Release);
    send(&mut client, b'R', b"[100,35]");
    let event = std::thread::scope(|scope| {
        let task = scope.spawn(|| relay.step());
        wait(|| gate.entered.load(Ordering::Acquire));
        // Keep the ACTUAL selected constructor held through its original 5s
        // request end. No smaller pre-connect deadline or fake failure.
        task.join().unwrap().unwrap()
    });
    assert!(matches!(event, ViewerRelayEvent::CheckCurrentIntent));
    assert_eq!(starts.load(Ordering::Acquire), before + 1);
    let error = fixture
        .runtime()
        .readonly()
        .query(
            crate::engine_metadata::EngineQuery::InventoryIds,
            end(),
            &crate::captured_client::CancellationToken::new(),
        )
        .unwrap_err();
    assert_eq!(error.fault(), crate::engine_metadata::EngineFault::Busy);
    relay.check_current_intent(&fixture.source).unwrap();
    send(&mut client, b'R', b"[101,36]");
    relay.step().unwrap();
    assert_eq!(
        starts.load(Ordering::Acquire),
        before + 1,
        "second resize cannot dispatch behind retained uncertainty"
    );
    gate.released.store(true, Ordering::Release);
    fixture
        .runtime()
        .settle_laptop_viewer_queries(&viewer, end())
        .unwrap();
    send(&mut client, b'R', b"[102,37]");
    relay.step().unwrap();
    assert_eq!(
        starts.load(Ordering::Acquire),
        before + 1,
        "settlement cannot retroactively confirm or replay resize"
    );
    send(&mut client, b'I', b"Q");
    std::thread::scope(|scope| {
        let task = scope.spawn(|| run(relay, &fixture));
        assert_eq!(receive(&mut client), (b'X', b"7".to_vec()));
        task.join().unwrap();
    });
    cleanup_component(&fixture, &existing, connection, hold, &service);
    drop(release);
}
