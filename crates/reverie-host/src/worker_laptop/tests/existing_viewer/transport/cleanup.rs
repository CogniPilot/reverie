//! A real pending resize constructor cannot consume the native viewer's
//! separate TERM/KILL phase. This witness changes no production algorithm.
use super::*;
use crate::captured_client::test_hooks::{Gate, Hooks};
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::Release);
    }
}
pub(super) struct UnwindRelease(pub(super) Arc<Gate>);
impl Drop for UnwindRelease {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.released.store(true, Ordering::Release);
        }
    }
}
#[test]
fn actual_pending_resize_query_cannot_hide_the_owned_native_viewer_during_cleanup() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::existing_viewer::transport::cleanup::actual_pending_resize_query_cannot_hide_the_owned_native_viewer_during_cleanup",
    ) {
        return;
    }
    let gate = Arc::new(Gate::default());
    gate.released.store(true, Ordering::Release);
    let _release = Release(gate.clone());
    let fixture = Fixture::employee_with_hooks(
        "created-viewer-group",
        Hooks {
            gate: Some(gate.clone()),
            ..Hooks::default()
        },
    );
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    eprintln!(
        "owned fixed fixture executable: {}; root: {}",
        program().display(),
        fixture.root.display()
    );
    let (mut client, connection, _hold) = accepted(&fixture, &service, "opencode");
    let (workflow, _created, released) = fixture.released_for_connection(&connection);
    let ViewerStart::Started(viewer) = fixture
        .runtime()
        .start_laptop_viewer_session_for_worker(&released, &connection)
        .unwrap()
    else {
        panic!("actual created viewer")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    let natural_exit = Instant::now() + Duration::from_secs(25);
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    fs::write(
        fixture.root.join("relay-query-control"),
        b"fixed actual query",
    )
    .unwrap();
    fs::write(fixture.root.join("relay-clients.out"), b"123 100 35\n").unwrap();
    let mut relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    gate.entered.store(false, Ordering::Release);
    gate.released.store(false, Ordering::Release);
    send(&mut client, b'R', b"[100,35]");
    let event = std::thread::scope(|scope| {
        let _unwind = UnwindRelease(gate.clone());
        let query = scope.spawn(|| relay.step());
        wait(|| gate.entered.load(Ordering::Acquire));
        // Keep the actual constructor through the original five-second resize
        // budget. Scope joins the caller; Release owns the exact native gate.
        query.join().unwrap().unwrap()
    });
    assert!(matches!(event, ViewerRelayEvent::CheckCurrentIntent));
    drop(relay);
    assert!(job.has_pending_native_work());
    assert_metadata_busy(&fixture);
    let result = fixture
        .runtime()
        .close_laptop_viewer(&viewer, Instant::now() + Duration::from_millis(5100));
    let native_still_running = job.status().unwrap().is_none();
    let native_counts = job.native_counts();
    eprintln!(
        "original native close: {result:?}; still_running={native_still_running}; counts={native_counts:?}"
    );
    assert!(
        result.is_err(),
        "the exact query constructor is still retained"
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    // Finish the unrelated exact query before fixture teardown; no replay or
    // new native signal is used to compensate for the product cleanup failure.
    finish_fixture(
        fixture,
        &viewer,
        &job,
        &gate,
        &service,
        natural_exit,
        native_counts,
    );
    // Decisive RED/GREEN assertions follow actual native/query finalization.
    assert!(
        !native_still_running,
        "pending resize settlement hid the real viewer from native cleanup"
    );
    assert_eq!(
        native_counts.1, 1,
        "one pinned native group decision despite retained query uncertainty"
    );
}
fn assert_metadata_busy(fixture: &Fixture) {
    let busy = fixture
        .runtime()
        .readonly()
        .query(
            crate::engine_metadata::EngineQuery::InventoryIds,
            end(),
            &crate::captured_client::CancellationToken::new(),
        )
        .unwrap_err();
    assert_eq!(busy.fault(), crate::engine_metadata::EngineFault::Busy);
}
fn finish_fixture(
    fixture: Fixture,
    viewer: &ViewerSession,
    job: &crate::worker_laptop::ViewerJob,
    gate: &Gate,
    service: &WorkerReportService,
    natural_exit: Instant,
    native_counts: (usize, usize),
) {
    gate.released.store(true, Ordering::Release);
    fixture
        .runtime()
        .settle_laptop_viewer_queries(viewer, end())
        .unwrap();
    while job.status().unwrap().is_none() {
        assert!(
            Instant::now() < natural_exit,
            "existing fixed fixture self-exit bound"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    job.test_reap_exited().unwrap();
    assert_eq!(
        job.native_counts(),
        native_counts,
        "no destructive signal after reap"
    );
    assert!(fixture.runtime().close(end()).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(
        service.close(end()).is_err(),
        "actual resource Hold remains counted"
    );
    std::mem::forget(fixture);
}
