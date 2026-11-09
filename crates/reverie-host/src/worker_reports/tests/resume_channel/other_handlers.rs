//! Real Q/J sockets and the original published native handler, never SID grants.
use super::*;
use std::sync::mpsc;

fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_reports::tests::resume_channel::other_handlers::{name}"
    ))
}

#[test]
fn original_q_excludes_only_itself_and_waits_for_j_parent_join_and_hold() {
    if isolated("original_q_excludes_only_itself_and_waits_for_j_parent_join_and_hold") {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let foreign = Arc::new(fixture.service());
    let (_q_client, mut q) = channel(&fixture, &service);
    let alone = q.other_original_handlers_settled(&service);
    let wrong_service = q.other_original_handlers_settled(&foreign);
    let (mut client, server) = fixture.sockets();
    send(&mut client,b'J',br#"{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}"#);
    let mut registered = service.register_worker_connection(server).unwrap();
    let constructor = registered.reserve_handler().unwrap();
    let (sent, received) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let source = fixture.clone();
    let thread = std::thread::spawn(move || {
        let AcceptedWorkerConnection::Launch(connection) = registered
            .receive(&source.collector, &super::super::launch::configuration())
            .unwrap()
        else {
            panic!("actual original J")
        };
        let hold = connection.retain_lifecycle().unwrap();
        sent.send((connection, hold)).unwrap();
        released.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    constructor.publish(thread).unwrap();
    let (connection, mut hold) = received.recv_timeout(Duration::from_secs(2)).unwrap();
    let running = q.other_original_handlers_settled(&service);
    connection.close_socket(end()).unwrap();
    let closed_tail = q.other_original_handlers_settled(&service);
    let record = service.records.lock().unwrap()[1].clone();
    let registry = service.records.lock().unwrap();
    let registry_busy = q.other_original_handlers_settled(&service);
    drop(registry);
    let handler = record.handler.lock().unwrap();
    let handler_busy = q.other_original_handlers_settled(&service);
    drop(handler);
    release.send(()).unwrap();
    record
        .settle_handler(
            &crate::worker_reports::budget::CleanupBudget::bounded(&service, end()),
            end(),
        )
        .unwrap();
    let joined_held = q.other_original_handlers_settled(&service);
    hold.release(end()).unwrap();
    let settled = q.other_original_handlers_settled(&service);
    let no_poison = !record.opaque() && !service.opaque.load(Ordering::Acquire);
    q.close_for_worker().unwrap();
    let closed_q = q.other_original_handlers_settled(&service);
    service.close(end()).unwrap();
    foreign.close(end()).unwrap();
    assert!(alone.unwrap() && settled.unwrap());
    assert!(wrong_service.is_err() && closed_q.is_err());
    for result in [
        running,
        closed_tail,
        registry_busy,
        handler_busy,
        joined_held,
    ] {
        assert!(!result.unwrap());
    }
    assert!(no_poison);
}

#[test]
fn unpublished_other_connection_cannot_supply_handler_completion_even_after_socket_close() {
    if isolated(
        "unpublished_other_connection_cannot_supply_handler_completion_even_after_socket_close",
    ) {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_q_client, mut q) = channel(&fixture, &service);
    let (_client, connection) = super::super::launch::launch(&service, &fixture);
    let mut hold = connection.retain_lifecycle().unwrap();
    let open = q.other_original_handlers_settled(&service);
    connection.close_socket(end()).unwrap();
    let closed = q.other_original_handlers_settled(&service);
    hold.release(end()).unwrap();
    q.close_for_worker().unwrap();
    service.close(end()).unwrap();
    assert!(!open.unwrap() && !closed.unwrap());
}

#[test]
fn unread_abandonment_requires_original_parent_drop_and_resource_close() {
    if isolated("unread_abandonment_requires_original_parent_drop_and_resource_close") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_q_client, mut q) = channel(&fixture, &service);
    let (_client, server) = fixture.sockets();
    let mut registered = service.register_worker_connection(server).unwrap();
    let construction = registered.reserve_handler().unwrap();
    let record = service.records.lock().unwrap()[1].clone();
    let mut hold = record.retain_lifecycle(&service).unwrap();
    drop(construction);
    let unproved = q.other_original_handlers_settled(&service);
    let not_started_unproved = !record.handler_job().unwrap().unwrap().known_settled();
    drop(registered);
    let no_start_is_known = record.handler_job().unwrap().unwrap().known_settled();
    let observed = q.other_original_handlers_settled(&service);
    hold.release(end()).unwrap();
    let released = q.other_original_handlers_settled(&service);
    let known_closed = record.settled();
    q.close_for_worker().unwrap();
    service.close(end()).unwrap();
    assert!(not_started_unproved && no_start_is_known && known_closed);
    assert!(!unproved.unwrap() && !observed.unwrap());
    assert!(released.unwrap());
}

#[test]
fn poisoned_original_handler_record_stays_unknown() {
    if isolated("poisoned_original_handler_record_stays_unknown") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_q_client, q) = channel(&fixture, &service);
    let (_client, _connection) = super::super::launch::launch(&service, &fixture);
    let record = service.records.lock().unwrap()[1].clone();
    let original = record.clone();
    assert!(
        std::thread::spawn(move || {
            let _held = original.handler.lock().unwrap();
            panic!("original handler poisoning control");
        })
        .join()
        .is_err()
    );
    assert!(q.other_original_handlers_settled(&service).is_err());
    assert!(record.opaque());
    assert!(service.close(end()).is_err());
}

#[test]
fn poisoned_original_registry_remains_unknown_instead_of_observed_settled() {
    if isolated("poisoned_original_registry_remains_unknown_instead_of_observed_settled") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_q_client, q) = channel(&fixture, &service);
    let original = service.clone();
    assert!(
        std::thread::spawn(move || {
            let _held = original.records.lock().unwrap();
            panic!("original registry poisoning control");
        })
        .join()
        .is_err()
    );
    assert!(q.other_original_handlers_settled(&service).is_err());
    assert!(service.opaque.load(Ordering::Acquire));
    assert!(service.close(end()).is_err());
}
