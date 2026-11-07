//! The real Created/no-session cleanup must settle its original constructor
//! slot as well as the native job. No lower close receipt fabricates transfer.
use super::*;
use crate::captured_client::test_hooks::Gate;
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::Release);
    }
}
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::worker_close::{name}"
    ))
}
#[test]
fn no_session_created_close_retains_exact_constructor_until_actual_slot_settlement() {
    if isolated("no_session_created_close_retains_exact_constructor_until_actual_slot_settlement") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_peer, connection, mut hold) = accepted(&fixture, &service, "original");
    let (created, pane) = ready(&fixture, &connection);
    let gate = Arc::new(Gate::default());
    std::thread::scope(|scope| {
        let _release = Release(gate.clone());
        let pause = gate.clone();
        let start = scope.spawn(|| {
            crate::worker_laptop::viewer::test_hooks::next_constructor(pause);
            runtime.start_laptop_viewer_session_for_worker(&pane, &connection)
        });
        wait(|| gate.entered.load(Ordering::Acquire));
        connection.close_socket(end()).unwrap();
        gate.released.store(true, Ordering::Release);
        assert!(matches!(
            start.join().unwrap().unwrap(),
            ViewerStart::Retained
        ));
    });
    wait(|| fixture.root.join("viewer-ready").is_file());
    let job = created
        .workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .clone()
        .unwrap();
    let client = runtime.installed_engine().engine.client.clone();
    let slot = Arc::new(Gate::default());
    let (sent, observed) = std::sync::mpsc::channel();
    let (refused, observation) = std::thread::scope(|scope| {
        let _release = Release(slot.clone());
        let locked = slot.clone();
        let actual = job.clone();
        let holding = client.clone();
        let holder = scope
            .spawn(move || holding.hold_cleanup_slot_for_owned_test(&locked, &actual, observed));
        wait(|| slot.entered.load(Ordering::Acquire));
        crate::captured_client::test_hooks::observe_viewer_release(sent);
        let refused = runtime
            .close_created_laptop_viewer_for_worker(&created)
            .is_err();
        slot.released.store(true, Ordering::Release);
        (refused, holder.join().unwrap())
    });
    let counts = job.native_counts();
    assert!(runtime.stop_deadline().is_none());
    assert!(observation.end.is_some() && observation.released_by_caller);
    assert!(observation.same_job && refused);
    job.require_closed().unwrap();
    assert!(client.require_viewer_released(&job).is_err());
    assert!(runtime.observe_created_final_storage(&created).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    runtime
        .close_created_laptop_viewer(&created, end())
        .unwrap();
    client.require_viewer_released(&job).unwrap();
    assert_eq!(
        job.native_counts(),
        counts,
        "no repeated native group signal"
    );
    assert_eq!(counts.1, 1);
    assert!(runtime.start_laptop_viewer_session(&pane, end()).is_err());
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    assert!(runtime.close(end()).is_err());
}
#[test]
fn worker_close_without_job_fences_consumed_guard_forward_alias_before_return() {
    if isolated("worker_close_without_job_fences_consumed_guard_forward_alias_before_return") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_peer, connection, mut hold) = accepted(&fixture, &service, "original");
    let (created, pane) = ready(&fixture, &connection);
    runtime
        .close_created_laptop_viewer_for_worker(&created)
        .unwrap();
    assert!(runtime.stop_deadline().is_none());
    connection.assert_open(runtime).unwrap();
    assert!(runtime.start_laptop_viewer_session(&pane, end()).is_err());
    assert!(!fixture.root.join("viewer-ready").exists());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    assert!(runtime.close(end()).is_err());
}
