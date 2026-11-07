//! Real mutex contention and actual first-stop field. Worker cleanup has no
//! caller aggregate before stop, then observes that SAME live stop bound.
use super::*;
use std::sync::mpsc;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_reports::tests::worker_cleanup::{name}"))
}
fn wait(mut ready: impl FnMut() -> bool) {
    let end = end();
    while !ready() {
        assert!(Instant::now() < end, "owned worker cleanup stage");
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn worker_socket_cleanup_waits_for_same_lifecycle_then_requires_actual_hold_release() {
    if isolated("worker_socket_cleanup_waits_for_same_lifecycle_then_requires_actual_hold_release")
    {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, connection) = super::launch::launch(&service, &fixture);
    let connection = Arc::new(connection);
    let mut hold = connection.retain_lifecycle().unwrap();
    let record = service.records.lock().unwrap()[0].clone();
    let budget = super::super::budget::CleanupBudget::bounded(&service, end());
    let locked = record.lifecycle_until(&budget).unwrap();
    let original = connection.clone();
    let (sent, received) = mpsc::channel();
    let task = std::thread::spawn(move || {
        sent.send(original.close_socket_for_worker()).unwrap();
    });
    wait(|| record.finished());
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    drop(locked);
    assert_eq!(
        received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap(),
        WorkerLaunchClose::SocketClosedLifecycleHeld
    );
    task.join().unwrap();
    assert_eq!(service.records.lock().unwrap().len(), 1);
    hold.release_for_worker().unwrap();
    service.close(end()).unwrap();
}
#[test]
fn no_ceiling_worker_cleanup_observes_first_stop_published_during_actual_lock_wait() {
    if isolated("no_ceiling_worker_cleanup_observes_first_stop_published_during_actual_lock_wait") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, connection) = super::launch::launch(&service, &fixture);
    let connection = Arc::new(connection);
    let _hold = connection.retain_lifecycle().unwrap();
    let record = service.records.lock().unwrap()[0].clone();
    let budget = super::super::budget::CleanupBudget::bounded(&service, end());
    let locked = record.lifecycle_until(&budget).unwrap();
    let original = connection.clone();
    let (sent, received) = mpsc::channel();
    let task = std::thread::spawn(move || {
        sent.send(original.close_socket_for_worker()).unwrap();
    });
    wait(|| record.finished());
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    // Existing cfg(test) expiry hook installs the real engine first-stop field
    // as already exhausted, with no production clock/configuration escape.
    fixture
        .runtime
        .installed_engine()
        .expire_stop_for_owned_test();
    assert!(
        received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_err()
    );
    task.join().unwrap();
    drop(locked);
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert!(service.close(Instant::now()).is_err());
}
