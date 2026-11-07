//! Actual worker cleanup retains the same native, read and storage owners.
use super::*;
use crate::captured_client::test_hooks::{Gate, Hooks};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::cleanup_worker::{name}"
    ))
}
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::Release);
    }
}
fn retained_after_closed_j(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
) -> (ExistingViewer, WorkerLaunchConnection, WorkerLaunchHold) {
    let (_peer, connection, hold) = accepted(fixture, service, "opencode");
    let existing = retained(fixture, &connection);
    let gate = Arc::new(Gate::default());
    std::thread::scope(|scope| {
        let _release = Release(gate.clone());
        let pause = gate.clone();
        let runtime = fixture.runtime().clone();
        let existing = &existing;
        let connection = &connection;
        let start = scope.spawn(move || {
            crate::worker_laptop::viewer::test_hooks::next_constructor(pause);
            runtime.start_existing_viewer_for_worker(existing, connection)
        });
        wait(|| gate.entered.load(Ordering::Acquire));
        connection.close_socket(end()).unwrap();
        gate.released.store(true, Ordering::Release);
        assert!(matches!(
            start.join().unwrap().unwrap(),
            ExistingViewerStart::Retained
        ));
    });
    wait(|| fixture.root.join("viewer-ready").is_file());
    (existing, connection, hold)
}

#[test]
fn actual_post_native_slot_contention_uses_saved_end_and_retains_the_same_constructor() {
    if isolated(
        "actual_post_native_slot_contention_uses_saved_end_and_retains_the_same_constructor",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (existing, connection, hold) = retained_after_closed_j(&fixture, &service);
    let job = existing.native_job_for_owned_test();
    let client = fixture.runtime().installed_engine().engine.client.clone();
    let gate = Arc::new(Gate::default());
    let (sent, observed) = std::sync::mpsc::channel();
    let (refused, observation) = std::thread::scope(|scope| {
        let _release = Release(gate.clone());
        let locked = gate.clone();
        let actual = job.clone();
        let holding = client.clone();
        let holder = scope
            .spawn(move || holding.hold_cleanup_slot_for_owned_test(&locked, &actual, observed));
        wait(|| gate.entered.load(Ordering::Acquire));
        crate::captured_client::test_hooks::observe_viewer_release(sent);
        let refused = fixture
            .runtime()
            .close_existing_viewer_for_worker(&existing)
            .is_err();
        gate.released.store(true, Ordering::Release);
        (refused, holder.join().unwrap())
    });
    let confirmed = job.require_closed().is_ok();
    let slot_retained = client.require_viewer_released(&job).is_err();
    let unreclaimed = fixture.runtime().reclaim_existing_relay(&existing).is_err();
    let held = StorageLease::acquire_migration(&fixture.source, &sid()).is_err();
    let counts = job.native_counts();
    assert!(
        fixture.runtime().stop_deadline().is_none(),
        "no invented global stop to bound slot waiting"
    );
    // Explicit lower-component recovery only after the refusal measurements.
    // It may settle the same known closed native slot; it is not App release.
    cleanup_component(&fixture, &existing, connection, hold, &service);
    assert!(client.require_viewer_released(&job).is_ok());
    assert!(
        observation.end.is_some(),
        "must reach actual confirmed-native slot release"
    );
    assert!(confirmed);
    assert!(
        refused,
        "actual saved phase end must bound post-native mutex waiting"
    );
    assert!(
        observation.released_by_caller,
        "worker returns before owned fallback unlock"
    );
    assert!(
        observation.same_job && slot_retained && unreclaimed && held,
        "same real slot/Box remain retained on refusal"
    );
    assert_eq!(counts.1, 1);
    assert_eq!(
        job.native_counts(),
        counts,
        "recovery cannot repeat native group signal"
    );
}

#[test]
fn actual_late_first_stop_during_guard_wait_keeps_fresh_native_term_and_original_stop_end() {
    if isolated(
        "actual_late_first_stop_during_guard_wait_keeps_fresh_native_term_and_original_stop_end",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-group");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (_client, connection, _hold) = accepted(&fixture, &service, "opencode");
    let (workflow, _created, released) = fixture.released_for_connection(&connection);
    let ViewerStart::Started(viewer) = fixture
        .runtime()
        .start_laptop_viewer_session_for_worker(&released, &connection)
        .unwrap()
    else {
        panic!("actual created viewer")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    let (sent, received) = std::sync::mpsc::channel();
    let runtime = fixture.runtime().clone();
    let result = std::thread::scope(|scope| {
        // This actual record guard drops before scope joins on every unwind.
        let locked = workflow.record.lock().unwrap();
        let viewer = &viewer;
        let close = scope.spawn(move || {
            crate::worker_laptop::viewer::test_hooks::observe_cleanup_wait(sent);
            runtime.close_laptop_viewer_for_worker(viewer)
        });
        let guard_end = received.recv_timeout(Duration::from_secs(3)).unwrap();
        let stop = fixture.runtime().request_stop();
        assert!(
            guard_end < stop,
            "actual pre-stop guard keeps original5.1s end"
        );
        let release = guard_end - Duration::from_millis(500);
        std::thread::sleep(release.saturating_duration_since(Instant::now()));
        let released_at = Instant::now();
        drop(locked);
        let result = close.join().unwrap();
        assert!(
            job.test_kill_end() >= released_at + Duration::from_secs(5),
            "guard wait cannot consume native TERM grace"
        );
        assert_eq!(fixture.runtime().stop_deadline(), Some(stop));
        result
    });
    assert_eq!(job.status().unwrap(), Some(-9));
    super::super::super::viewer::group::classify_group_close(&fixture, &workflow, result);
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(fixture.runtime().close(end()).is_err());
    assert!(service.close(end()).is_err());
}

#[test]
fn actual_pending_existing_stop_read_cannot_hide_the_native_viewer_or_release_its_box() {
    if isolated(
        "actual_pending_existing_stop_read_cannot_hide_the_native_viewer_or_release_its_box",
    ) {
        return;
    }
    let gate = Arc::new(Gate::default());
    gate.released.store(true, Ordering::Release);
    let _release = Release(gate.clone());
    let fixture = Fixture::employee_with_hooks(
        "created-viewer-echo",
        Hooks {
            gate: Some(gate.clone()),
            ..Hooks::default()
        },
    );
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (_client, connection, _hold) = accepted(&fixture, &service, "opencode");
    let (mut storage, plan, _request, inspected) =
        super::super::stop::canonical_originals(&fixture);
    let receipt = super::super::relay::receipt(&fixture, &mut storage);
    let existing = fixture
        .runtime()
        .retain_existing_relay_for_connection(storage, plan, inspected, receipt, &connection)
        .unwrap_or_else(|e| panic!("{}", e.cause()));
    let ExistingViewerStart::Started(viewer) = fixture
        .runtime()
        .start_existing_viewer_for_worker(&existing, &connection)
        .unwrap()
    else {
        panic!("actual existing viewer")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    gate.entered.store(false, Ordering::Release);
    gate.released.store(false, Ordering::Release);
    let runtime = fixture.runtime().clone();
    let failure = std::thread::scope(|scope| {
        let _unwind = super::cleanup::UnwindRelease(gate.clone());
        let existing = &existing;
        // A five-second bounded component call creates a REAL read ticket;
        // this is not a fake worker aggregate deadline or pre-connect timer.
        let call = scope.spawn(move || {
            runtime.stop_existing_viewer_laptop(existing, Instant::now() + Duration::from_secs(5))
        });
        wait(|| gate.entered.load(Ordering::Acquire));
        call.join().unwrap().unwrap_err()
    });
    assert!(!fixture.root.join("stopped-laptop").exists());
    assert!(
        fixture
            .runtime()
            .close_existing_viewer_for_worker(&existing)
            .is_err()
    );
    assert!(
        viewer.native_status_for_owned_test().unwrap().is_some(),
        "pending stop read cannot postpone native viewer cleanup"
    );
    assert_eq!(viewer.native_counts_for_owned_test().1, 1);
    assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    eprintln!("original stop failure retained: {failure:?}");
    gate.released.store(true, Ordering::Release);
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    assert!(
        !fixture.root.join("stopped-laptop").exists(),
        "settling actual read never replays stop effects"
    );
    assert_eq!(
        viewer.native_counts_for_owned_test().1,
        1,
        "no second native group signal"
    );
    assert!(
        fixture.runtime().reclaim_existing_relay(&existing).is_err(),
        "unknown original stop remains fenced after settlement"
    );
    assert!(fixture.runtime().close(end()).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(service.close(end()).is_err());
}
