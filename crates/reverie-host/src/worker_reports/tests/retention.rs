use super::launch::{configuration, launch};
use super::*;
#[test]
fn negative_record_identity_survives_socket_close_without_conferring_progress_or_release() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, connection) = launch(&service, &fixture);
    let mut hold = connection.retain_lifecycle().unwrap();
    let (_other_client, other) = launch(&service, &fixture);
    assert!(other.assert_same_lifecycle_record(&hold).is_err());
    connection.assert_same_lifecycle_record(&hold).unwrap();
    connection.close_socket(end()).unwrap();
    connection.assert_same_lifecycle_record(&hold).unwrap();
    assert!(connection.assert_lifecycle_hold(&hold).is_err());
    assert_eq!(
        service.records.lock().unwrap().len(),
        2,
        "identity is not retirement"
    );
    hold.release(end()).unwrap();
    other.close(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn known_closed_socket_holds_the_same_capacity_until_exact_checked_lifecycle_release() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, connection) = launch(&service, &fixture);
    let mut hold = connection.retain_lifecycle().unwrap();
    assert_eq!(
        connection.close_socket(end()).unwrap(),
        WorkerLaunchClose::SocketClosedLifecycleHeld
    );
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert!(matches!(
        connection.close(end()),
        Err(WorkerReportError::LifecycleRetained)
    ));
    let others = (1..service.limit)
        .map(|_| launch(&service, &fixture))
        .collect::<Vec<_>>();
    let (_client, socket) = fixture.sockets();
    assert!(matches!(
        service.accept(socket, &fixture.collector, &configuration()),
        Err(WorkerReportError::Stopping)
    ));
    hold.release(end()).unwrap();
    hold.release(end()).unwrap();
    let (_client, replacement) = launch(&service, &fixture);
    assert_eq!(service.records.lock().unwrap().len(), service.limit);
    let (_client, socket) = fixture.sockets();
    assert!(matches!(
        service.accept(socket, &fixture.collector, &configuration()),
        Err(WorkerReportError::Stopping)
    ));
    for (_, other) in others {
        other.close(end()).unwrap();
    }
    replacement.close(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn repeated_abandoned_closed_requests_cannot_bypass_the_actual_record_limit() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    for count in 1..=service.limit {
        let (_client, connection) = launch(&service, &fixture);
        let hold = connection.retain_lifecycle().unwrap();
        assert_eq!(
            connection.close_socket(end()).unwrap(),
            WorkerLaunchClose::SocketClosedLifecycleHeld
        );
        drop(hold);
        drop(connection);
        assert_eq!(service.records.lock().unwrap().len(), count);
    }
    let (mut client, socket) = fixture.sockets();
    assert!(matches!(
        service.accept(socket, &fixture.collector, &configuration()),
        Err(WorkerReportError::Stopping)
    ));
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert!(
        service.close(end()).is_err(),
        "closed descriptors are not actual lifecycle finalization"
    );
}
#[test]
fn a_live_socket_still_counts_after_hold_release_and_mint_is_one_shot() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, connection) = launch(&service, &fixture);
    let mut hold = connection.retain_lifecycle().unwrap();
    assert!(connection.retain_lifecycle().is_err());
    hold.release(end()).unwrap();
    assert!(connection.retain_lifecycle().is_err());
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert!(service.close(Instant::now()).is_err());
    assert_eq!(
        connection.close_socket(end()).unwrap(),
        WorkerLaunchClose::Complete
    );
    service.close(end()).unwrap();
}
#[test]
fn opaque_close_cannot_be_forgiven_before_or_after_logical_lifecycle_release() {
    for release_first in [false, true] {
        let fixture = Fixture::new();
        let service = Arc::new(fixture.service());
        let (mut client, connection) = launch(&service, &fixture);
        let mut hold = connection.retain_lifecycle().unwrap();
        if release_first {
            hold.release(end()).unwrap();
        }
        CLOSE_REFUSAL.with(|flag| flag.set(true));
        assert!(connection.close_socket(end()).is_err());
        assert_eq!(
            client.read(&mut [0]).unwrap(),
            0,
            "owned descriptor actually consumed"
        );
        assert!(hold.release(end()).is_err());
        drop(hold);
        drop(connection);
        assert_eq!(service.records.lock().unwrap().len(), 1);
        assert!(service.close(end()).is_err());
        assert!(service.close(end()).is_err());
    }
}
#[test]
fn mint_never_waits_for_admission_and_cannot_restart_after_actual_close() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, connection) = launch(&service, &fixture);
    std::thread::scope(|scope| {
        let records = service.records.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let source = &connection;
        let task = scope.spawn(move || {
            let result = source.retain_lifecycle();
            tx.send(result.is_err()).unwrap();
            result
        });
        let before_release = rx.recv_timeout(Duration::from_secs(2));
        drop(records);
        let result = task.join().unwrap();
        assert!(before_release.unwrap());
        assert!(result.is_err());
    });
    let mut hold = connection.retain_lifecycle().unwrap();
    hold.release(end()).unwrap();
    connection.close(end()).unwrap();
    assert!(connection.retain_lifecycle().is_err());
    service.close(end()).unwrap();
}
#[test]
fn release_uses_the_original_expired_stop_budget_under_actual_registry_contention() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, connection) = launch(&service, &fixture);
    let mut hold = connection.retain_lifecycle().unwrap();
    connection.close_socket(end()).unwrap();
    service.engine.expire_stop_for_owned_test();
    std::thread::scope(|scope| {
        let records = service.records.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let task = scope.spawn(move || {
            let start = Instant::now();
            let result = hold.release(Instant::now() + Duration::from_secs(2));
            tx.send((result.is_err(), start.elapsed())).unwrap();
            hold
        });
        // Setup scheduling is separate from the actual release elapsed bound.
        let result = rx.recv_timeout(Duration::from_secs(2));
        drop(records);
        let hold = task.join().unwrap();
        let (refused, elapsed) = result.unwrap();
        assert!(refused);
        assert!(elapsed < Duration::from_millis(500));
        drop(hold);
    });
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert!(service.close(end()).is_err());
}

#[test]
fn dropped_hold_keeps_actual_engine_origin_but_checked_known_release_does_not() {
    for release in [false, true] {
        let weak = {
            let fixture = Fixture::new();
            let service = Arc::new(fixture.service());
            let weak = Arc::downgrade(&service.engine);
            let (_client, connection) = launch(&service, &fixture);
            let mut hold = connection.retain_lifecycle().unwrap();
            connection.close_socket(end()).unwrap();
            if release {
                hold.release(end()).unwrap();
                service.close(end()).unwrap();
            }
            drop(hold);
            drop(connection);
            drop(service);
            weak
        };
        assert_eq!(weak.upgrade().is_some(), !release);
    }
}
