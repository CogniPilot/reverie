//! Actual original-J worker constructors. Existing bounded APIs stay exercised
//! by the unchanged parent controls; these accept no caller deadline or grant.
use super::*;
use crate::{
    captured_client::{
        Policy,
        test_hooks::{Gate, Hooks},
    },
    engine_metadata::MAX_QUERY_SECONDS,
};
use std::sync::{atomic::Ordering, mpsc};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::worker::{name}"
    ))
}
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::Release);
    }
}
struct UnwindCleanup {
    runtime: Arc<crate::worker_runtime::WorkerRuntime>,
    gate: Arc<Gate>,
    token: Option<crate::captured_client::CancellationToken>,
}
impl Drop for UnwindCleanup {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.runtime.request_stop();
            if let Some(token) = &self.token {
                token.cancel();
            }
        }
        self.gate.released.store(true, Ordering::Release);
    }
}
#[test]
fn actual_worker_handoff_observes_stop_during_the_same_slot_lock_and_retains_the_spawned_job() {
    if isolated(
        "actual_worker_handoff_observes_stop_during_the_same_slot_lock_and_retains_the_spawned_job",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (_client, connection, hold) = accepted(&fixture, &service, "worker-handoff");
    let existing = retained(&fixture, &connection);
    let constructor = Arc::new(Gate::default());
    let slot = Arc::new(Gate::default());
    let client = fixture.runtime().installed_engine().engine.client.clone();
    let runtime = fixture.runtime().clone();
    let pause = constructor.clone();
    let locked = slot.clone();
    std::thread::scope(|scope| {
        let _constructor = Release(constructor.clone());
        let _slot = UnwindCleanup {
            runtime: runtime.clone(),
            gate: slot.clone(),
            token: None,
        };
        let existing = &existing;
        let connection = &connection;
        let (sent, received) = mpsc::channel();
        let viewer = scope.spawn(move || {
            crate::worker_laptop::viewer::test_hooks::next_constructor(pause);
            sent.send(runtime.start_existing_viewer_for_worker(existing, connection))
                .unwrap();
        });
        wait(|| constructor.entered.load(Ordering::Acquire));
        let holding = scope.spawn(move || client.hold_actual_slot_for_owned_test(&locked));
        wait(|| slot.entered.load(Ordering::Acquire));
        constructor.released.store(true, Ordering::Release);
        wait(|| fixture.root.join("viewer-ready").is_file());
        assert!(matches!(
            received.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        let stop = fixture.runtime().request_stop();
        slot.released.store(true, Ordering::Release);
        holding.join().unwrap();
        assert!(matches!(
            received
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap(),
            ExistingViewerStart::Retained
        ));
        viewer.join().unwrap();
        assert_eq!(fixture.runtime().stop_deadline(), Some(stop));
    });
    assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
    cleanup_component(&fixture, &existing, connection, hold, &service);
}
#[test]
fn actual_worker_created_constructor_keeps_original_j_through_full_real_pipeline() {
    if isolated("actual_worker_created_constructor_keeps_original_j_through_full_real_pipeline") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, mut hold) = accepted(&fixture, &service, "original-worker");
    let (workflow, _created, released) = fixture.released_for_connection(&connection);
    let (_other, foreign, mut foreign_hold) = accepted(&fixture, &service, "other-same-SID");
    assert!(
        fixture
            .runtime()
            .start_laptop_viewer_session_for_worker(&released, &foreign)
            .is_err()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
    let ViewerStart::Started(viewer) = fixture
        .runtime()
        .start_laptop_viewer_session_for_worker(&released, &connection)
        .unwrap()
    else {
        panic!("actual worker constructor")
    };
    assert!(viewer.same_workflow(&workflow));
    let relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    let reason = std::thread::scope(|scope| {
        let task = scope.spawn(|| run(relay, &fixture));
        send(&mut client, b'I', b"Q");
        assert_eq!(receive(&mut client), (b'X', b"7".to_vec()));
        task.join().unwrap()
    });
    assert!(matches!(reason, ViewerRelayEnd::ViewerExited(7)));
    fixture
        .runtime()
        .close_laptop_viewer(&viewer, end())
        .unwrap();
    foreign.close_socket(end()).unwrap();
    foreign_hold.release(end()).unwrap();
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
    assert!(
        fixture.runtime().reclaim_laptop_network(workflow).is_err(),
        "created storage remains real custody, no global/release credit"
    );
}
#[test]
fn worker_existing_constructor_rejects_other_same_sid_before_mutation_and_returns_same_box_after_close()
 {
    if isolated(
        "worker_existing_constructor_rejects_other_same_sid_before_mutation_and_returns_same_box_after_close",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "actual-worker");
    let existing = retained(&fixture, &connection);
    let (_other, foreign, mut other_hold) = accepted(&fixture, &service, "same-SID-other");
    assert!(
        fixture
            .runtime()
            .start_existing_viewer_for_worker(&existing, &foreign)
            .is_err()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
    let ExistingViewerStart::Started(viewer) = fixture
        .runtime()
        .start_existing_viewer_for_worker(&existing, &connection)
        .unwrap()
    else {
        panic!("actual worker viewer")
    };
    let reason = std::thread::scope(|scope| {
        let relay = connection
            .begin_viewer_relay(fixture.runtime(), &viewer)
            .unwrap();
        let task = scope.spawn(|| run(relay, &fixture));
        send(&mut client, b'I', b"Q");
        assert_eq!(receive(&mut client), (b'X', b"7".to_vec()));
        task.join().unwrap()
    });
    assert!(matches!(reason, ViewerRelayEnd::ViewerExited(7)));
    foreign.close_socket(end()).unwrap();
    other_hold.release(end()).unwrap();
    cleanup_component(&fixture, &existing, connection, hold, &service);
}
#[test]
fn worker_waits_beyond_original_query_limit_without_replay_or_cancelling_another_constructor() {
    if isolated(
        "worker_waits_beyond_original_query_limit_without_replay_or_cancelling_another_constructor",
    ) {
        return;
    }
    let gate = Arc::new(Gate::default());
    gate.released.store(true, Ordering::Release);
    let _release = Release(gate.clone());
    let fixture = Fixture::employee_with_hooks(
        "created-viewer-metadata",
        Hooks {
            gate: Some(gate.clone()),
            ..Hooks::default()
        },
    );
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (_client, connection, hold) = accepted(&fixture, &service, "worker-wait");
    let existing = retained(&fixture, &connection);
    gate.entered.store(false, Ordering::Release);
    gate.released.store(false, Ordering::Release);
    let client = fixture.runtime().installed_engine().engine.client.clone();
    let native = client.clone();
    let token = crate::captured_client::CancellationToken::new();
    let cancellation = token.clone();
    let original = Instant::now() + Duration::from_secs(MAX_QUERY_SECONDS);
    let busy = Arc::new(Gate::default());
    let pause = busy.clone();
    let runtime = fixture.runtime().clone();
    let (sent, received) = mpsc::channel();
    std::thread::scope(|scope| {
        let _cleanup = UnwindCleanup {
            runtime: runtime.clone(),
            gate: gate.clone(),
            token: Some(token.clone()),
        };
        let query = scope.spawn(move || {
            native.run_scoped(
                vec!["ps".into(), "-aq".into(), "--no-trunc".into()],
                original,
                &cancellation,
                Policy {
                    maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                    maximum_output: 4 * 1024 * 1024,
                    successful_exit: true,
                },
            )
        });
        wait(|| gate.entered.load(Ordering::Acquire));
        let existing = &existing;
        let connection = &connection;
        let viewer = scope.spawn(move || {
            crate::worker_laptop::viewer::test_hooks::observe_busy(pause);
            sent.send(runtime.start_existing_viewer_for_worker(existing, connection))
                .unwrap();
        });
        wait(|| busy.entered.load(Ordering::Acquire));
        let waited = Instant::now();
        let failure = query.join().unwrap().err().unwrap();
        let call = failure.call.expect("actual retained metadata constructor");
        assert!(failure.error.is_uncertain());
        let beyond = waited + Duration::from_secs(MAX_QUERY_SECONDS) + Duration::from_millis(200);
        std::thread::sleep(beyond.saturating_duration_since(Instant::now()));
        assert!(
            matches!(received.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "worker has no invented original20s constructor ceiling"
        );
        assert!(!fixture.root.join("viewer-ready").exists());
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        gate.released.store(true, Ordering::Release);
        client.settle_call(&call, end()).unwrap();
        let ExistingViewerStart::Started(session) = received
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap()
        else {
            panic!("same worker constructor")
        };
        viewer.join().unwrap();
        fixture
            .runtime()
            .close_laptop_viewer(&session, end())
            .unwrap();
    });
    cleanup_component(&fixture, &existing, connection, hold, &service);
}
#[test]
fn worker_admission_wait_observes_original_first_stop_without_a_fresh_budget_or_spawn() {
    if isolated(
        "worker_admission_wait_observes_original_first_stop_without_a_fresh_budget_or_spawn",
    ) {
        return;
    }
    let gate = Arc::new(Gate::default());
    gate.released.store(true, Ordering::Release);
    let _release = Release(gate.clone());
    let fixture = Fixture::employee_with_hooks(
        "created-viewer-metadata",
        Hooks {
            gate: Some(gate.clone()),
            ..Hooks::default()
        },
    );
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (_client, connection, _hold) = accepted(&fixture, &service, "worker-original-stop");
    let existing = retained(&fixture, &connection);
    gate.entered.store(false, Ordering::Release);
    gate.released.store(false, Ordering::Release);
    let client = fixture.runtime().installed_engine().engine.client.clone();
    let native = client.clone();
    let token = crate::captured_client::CancellationToken::new();
    let cancellation = token.clone();
    let original = Instant::now() + Duration::from_secs(MAX_QUERY_SECONDS);
    let busy = Arc::new(Gate::default());
    let seen = busy.clone();
    let runtime = fixture.runtime().clone();
    std::thread::scope(|scope| {
        let _cleanup = UnwindCleanup {
            runtime: runtime.clone(),
            gate: gate.clone(),
            token: Some(token.clone()),
        };
        let query = scope.spawn(move || {
            native.run_scoped(
                vec!["ps".into(), "-aq".into(), "--no-trunc".into()],
                original,
                &cancellation,
                Policy {
                    maximum: Duration::from_secs(MAX_QUERY_SECONDS),
                    maximum_output: 4 * 1024 * 1024,
                    successful_exit: true,
                },
            )
        });
        wait(|| gate.entered.load(Ordering::Acquire));
        let existing = &existing;
        let connection = &connection;
        let worker = scope.spawn(move || {
            crate::worker_laptop::viewer::test_hooks::observe_busy(seen);
            runtime.start_existing_viewer_for_worker(existing, connection)
        });
        wait(|| busy.entered.load(Ordering::Acquire));
        fixture
            .runtime()
            .installed_engine()
            .expire_stop_for_owned_test();
        assert!(matches!(
            worker.join().unwrap().unwrap(),
            ExistingViewerStart::Retained
        ));
        assert!(!fixture.root.join("viewer-ready").exists());
        assert!(
            fixture
                .runtime()
                .start_existing_viewer_for_worker(existing, connection)
                .is_err()
        );
        // Test-only owner cleanup of the unrelated query uses THAT call's
        // original supplied end, not a renewed Runtime/service cleanup budget.
        token.cancel();
        gate.released.store(true, Ordering::Release);
        let failure = query.join().unwrap().err().unwrap();
        if let Some(call) = failure.call {
            client.settle_call(&call, original).unwrap();
        }
    });
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(service.close(Instant::now()).is_err());
    fixture.retain_after_expired_stop();
}
