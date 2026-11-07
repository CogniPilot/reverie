//! Actual std threads and same socket records. No engine, private service,
//! callback permission, detached-thread success or synthetic no-thread proof.
use super::*;
use crate::captured_client::test_hooks::Gate;
use std::sync::mpsc;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_reports::tests::handler::{name}"))
}
fn wait(mut condition: impl FnMut() -> bool) {
    let end = end();
    while !condition() {
        assert!(Instant::now() < end, "owned handler stage bound");
        std::thread::sleep(Duration::from_millis(1));
    }
}
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::Release);
    }
}
fn tail(gate: &Gate) {
    gate.entered.store(true, Ordering::Release);
    while !gate.released.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn actual_thread_cannot_read_before_handle_publication_and_remains_counted_after_socket_close() {
    if isolated(
        "actual_thread_cannot_read_before_handle_publication_and_remains_counted_after_socket_close",
    ) {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'T', REQUEST);
    let mut registered = service.register_worker_connection(server).unwrap();
    let constructor = registered.reserve_handler().unwrap();
    let record = service.records.lock().unwrap()[0].clone();
    let other = (1..service.limit)
        .map(|_| {
            let (_client, server) = fixture.sockets();
            service.register_worker_connection(server).unwrap()
        })
        .collect::<Vec<_>>();
    let gate = Arc::new(Gate::default());
    let release = Release(gate.clone());
    let paused = gate.clone();
    let source = fixture.clone();
    let (sent, received) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let response = registered
            .receive(&source.collector, &super::launch::configuration())
            .unwrap();
        assert!(matches!(
            response,
            AcceptedWorkerConnection::ReportCompleted
        ));
        sent.send(()).unwrap();
        tail(&paused);
    });
    wait(|| {
        record
            .handler
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .test_entered()
    });
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert!(!record.finished());
    constructor.publish(thread).unwrap();
    received.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(reply(&mut client).0, b'J');
    wait(|| gate.entered.load(Ordering::Acquire));
    assert!(record.socket_closed_known());
    let (_client, server) = fixture.sockets();
    assert!(service.register_worker_connection(server).is_err());
    assert_eq!(
        service.collect_worker_handlers().unwrap(),
        WorkerHandlersProgress::Pending
    );
    gate.released.store(true, Ordering::Release);
    service.settle_worker_handlers(end()).unwrap();
    assert_eq!(service.records.lock().unwrap().len(), service.limit - 1);
    let (_client, server) = fixture.sockets();
    service
        .register_worker_connection(server)
        .unwrap()
        .close()
        .unwrap();
    for registered in other {
        registered.close().unwrap();
    }
    service.close(end()).unwrap();
    drop(release);
}
#[test]
fn actual_j_hold_release_cannot_remove_a_running_handler_and_shutdown_requires_its_join() {
    if isolated(
        "actual_j_hold_release_cannot_remove_a_running_handler_and_shutdown_requires_its_join",
    ) {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client,b'J',br#"{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}"#);
    let mut registered = service.register_worker_connection(server).unwrap();
    let constructor = registered.reserve_handler().unwrap();
    let gate = Arc::new(Gate::default());
    let release = Release(gate.clone());
    let paused = gate.clone();
    let source = fixture.clone();
    let (sent, received) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let AcceptedWorkerConnection::Launch(connection) = registered
            .receive(&source.collector, &super::launch::configuration())
            .unwrap()
        else {
            panic!("actual J")
        };
        let hold = connection.retain_lifecycle().unwrap();
        sent.send((connection, hold)).unwrap();
        tail(&paused);
    });
    constructor.publish(thread).unwrap();
    let (connection, mut hold) = received.recv_timeout(Duration::from_secs(2)).unwrap();
    wait(|| gate.entered.load(Ordering::Acquire));
    assert_eq!(
        connection.close_socket(end()).unwrap(),
        WorkerLaunchClose::SocketClosedLifecycleHeld
    );
    hold.release(end()).unwrap();
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert_eq!(
        connection.close_socket(end()).unwrap(),
        WorkerLaunchClose::SocketClosedHandlerRetained
    );
    assert!(service.close(Instant::now()).is_err());
    gate.released.store(true, Ordering::Release);
    service.settle_worker_handlers(end()).unwrap();
    service.close(end()).unwrap();
    drop(release);
}
#[test]
fn abandoned_publication_and_wrong_actual_thread_handle_never_become_completed_records() {
    if isolated(
        "abandoned_publication_and_wrong_actual_thread_handle_never_become_completed_records",
    ) {
        return;
    }
    for wrong in [false, true] {
        let fixture = Arc::new(Fixture::new());
        let service = Arc::new(fixture.service());
        let (_client, server) = fixture.sockets();
        let mut registered = service.register_worker_connection(server).unwrap();
        let constructor = registered.reserve_handler().unwrap();
        let record = service.records.lock().unwrap()[0].clone();
        let source = fixture.clone();
        let actual = std::thread::spawn(move || {
            assert!(
                registered
                    .receive(&source.collector, &super::launch::configuration())
                    .is_err()
            );
        });
        wait(|| {
            record
                .handler
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .test_entered()
        });
        if wrong {
            constructor.publish(std::thread::spawn(|| {})).unwrap();
        } else {
            drop(constructor);
        }
        actual.join().unwrap();
        assert!(service.close(Instant::now()).is_err());
        assert_eq!(service.records.lock().unwrap().len(), 1);
    }
}
#[test]
fn supplied_error_without_actual_unread_token_drop_cannot_prove_failed_spawn() {
    if isolated("supplied_error_without_actual_unread_token_drop_cannot_prove_failed_spawn") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, server) = fixture.sockets();
    let mut registered = service.register_worker_connection(server).unwrap();
    let constructor = registered.reserve_handler().unwrap();
    assert!(matches!(
        constructor.spawn_failed(std::io::Error::other("data is not a spawn witness")),
        Err(WorkerReportError::Finalization { .. })
    ));
    assert!(registered.close().is_err());
    assert!(service.close(Instant::now()).is_err());
    assert_eq!(service.records.lock().unwrap().len(), 1);
}
#[test]
fn actual_failed_os_thread_creation_returns_unread_socket_on_constructor_thread_before_slot_retires()
 {
    if isolated(
        "actual_failed_os_thread_creation_returns_unread_socket_on_constructor_thread_before_slot_retires",
    ) {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let (_client, server) = fixture.sockets();
    let mut registered = service.register_worker_connection(server).unwrap();
    let constructor = registered.reserve_handler().unwrap();
    let source = fixture.clone();
    // This isolated owning process requests a stack larger than Linux's user
    // address space. A genuine pthread creation refusal drops the ORIGINAL
    // unread token in the builder's closure on this constructing thread.
    let result = std::thread::Builder::new()
        .stack_size(isize::MAX as usize)
        .spawn(move || {
            let _ = registered.receive(&source.collector, &super::launch::configuration());
        });
    let error = match result {
        Err(error) => error,
        Ok(thread) => {
            constructor.publish(thread).unwrap();
            service.close(end()).unwrap();
            panic!("owned oversize stack unexpectedly started");
        }
    };
    assert!(matches!(
        constructor.spawn_failed(error),
        Err(WorkerReportError::Io(_))
    ));
    assert_eq!(
        service.collect_worker_handlers().unwrap(),
        WorkerHandlersProgress::Settled
    );
    assert!(service.records.lock().unwrap().is_empty());
    service.close(end()).unwrap();
}
