//! Real installing lifecycle mutex and original 34-second first-stop. No
//! external clock/expiry hook or configuration-selected cleanup budget.
use super::*;
use crate::{reservation_gate::tests::Tree, test_process};
use std::{cell::RefCell, sync::mpsc, time::Duration};
thread_local! {
    static CAPTURE: RefCell<Option<test_process::PausePoint<Option<Instant>>>> = const { RefCell::new(None) };
}
pub(super) fn captured(observed: Option<Instant>) {
    CAPTURE.with(|capture| {
        if let Some(point) = capture.borrow_mut().take() {
            point.wait(observed);
        }
    });
}
struct Resume(std::sync::mpsc::SyncSender<()>);
impl Drop for Resume {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}
fn broker(tree: &Tree) -> InstallingBroker {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
    std::fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let snapshot =
        crate::worker_validation::load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap = reverie_host::engine_metadata::EngineBootstrap::from_service(
        crate::test_process::engine_program().as_os_str(),
        std::collections::BTreeMap::new(),
        tree.root.clone(),
    )
    .unwrap();
    let runtime = reverie_host::worker_runtime::WorkerRuntime::new(
        reverie_host::installed_worker_engine::InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    InstallingBroker::new(snapshot, runtime).unwrap()
}

#[test]
fn worker_lifecycle_wait_observes_actual_first_stop_published_after_no_stop_capture() {
    crate::test_process::owning_case!(
        worker_lifecycle_wait_observes_actual_first_stop_published_after_no_stop_capture
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (returned_before_unlock, refused, stop) = std::thread::scope(|scope| {
        let locked = broker.installed.lifecycle().unwrap();
        let (pause, observed, resume) = test_process::pause_point();
        let release = Resume(resume);
        let (sent, received) = mpsc::channel();
        let source = &broker;
        scope.spawn(move || {
            CAPTURE.with(|slot| *slot.borrow_mut() = Some(pause));
            let acquired = source
                .installed
                .cleanup_lifecycle(&source.storage.runtime)
                .is_ok();
            let _ = sent.send(acquired);
        });
        assert!(
            observed
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_none()
        );
        let stop = broker.request_stop();
        drop(release);
        let early = received
            .recv_timeout(stop.saturating_duration_since(Instant::now()) + Duration::from_secs(2));
        let returned_before_unlock = early.is_ok();
        drop(locked);
        let acquired =
            early.unwrap_or_else(|_| received.recv_timeout(Duration::from_secs(2)).unwrap());
        (returned_before_unlock, !acquired, stop)
    });
    assert_eq!(
        broker.request_stop(),
        stop,
        "actual original end cannot renew"
    );
    assert!(Instant::now() >= stop, "original deadline really expired");
    // No native operation or resource was opened by this mutex-only control.
    // Their actual known-idle close is distinct from the exhausted wait budget
    // and does not acknowledge laptop/storage/global resource settlement.
    broker.close_command_telemetry(stop).unwrap();
    broker.storage.runtime.close(stop).unwrap();
    assert!(
        returned_before_unlock,
        "late first-stop must bound the held lifecycle wait"
    );
    assert!(refused, "expired stop cannot produce a lifecycle owner");
}

#[test]
fn worker_lifecycle_wait_without_stop_retains_no_prestop_aggregate_deadline() {
    crate::test_process::owning_case!(
        worker_lifecycle_wait_without_stop_retains_no_prestop_aggregate_deadline
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    std::thread::scope(|scope| {
        let locked = broker.installed.lifecycle().unwrap();
        let (pause, observed, resume) = test_process::pause_point();
        let release = Resume(resume);
        let (sent, received) = mpsc::channel();
        let source = &broker;
        scope.spawn(move || {
            CAPTURE.with(|slot| *slot.borrow_mut() = Some(pause));
            let _ = sent.send(
                source
                    .installed
                    .cleanup_lifecycle(&source.storage.runtime)
                    .is_ok(),
            );
        });
        assert!(
            observed
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_none()
        );
        drop(release);
        let early = received.recv_timeout(Duration::from_millis(40));
        drop(locked);
        assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)));
        assert!(received.recv_timeout(Duration::from_secs(2)).unwrap());
    });
    assert!(broker.storage.runtime.stop_deadline().is_none());
    broker
        .close_command_telemetry(Instant::now() + Duration::from_secs(2))
        .unwrap();
    broker
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
