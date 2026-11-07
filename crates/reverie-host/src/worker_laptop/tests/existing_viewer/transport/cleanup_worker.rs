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
