//! Actual owned sockets/kernel peers and the same admission/finalizers. No
//! purpose payload here is executed or treated as resource/start permission.
use super::*;
mod protected;

fn accept(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
    stream: UnixStream,
) -> WorkerServiceConnection {
    let AcceptedWorkerServiceConnection::Service(connection) = service
        .register_worker_connection(stream)
        .unwrap()
        .receive_service_for_worker(&fixture.collector, &super::launch::configuration())
        .unwrap()
    else {
        panic!("actual non-launch purpose owner");
    };
    connection
}

#[test]
fn all_original_service_purposes_preserve_actual_peer_payload_and_counted_socket() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    for (kind, purpose) in [
        (b'M', WorkerServicePurpose::ChatImages),
        (b'Y', WorkerServicePurpose::ResumeRegistration),
        (b'Q', WorkerServicePurpose::ResourceActor),
        (b'G', WorkerServicePurpose::GoalCustody),
        (b'C', WorkerServicePurpose::Control),
        (b'L', WorkerServicePurpose::ProtectedLaunch),
    ] {
        let (mut client, server) = fixture.sockets();
        let raw = b"not authority or parsed request";
        send(&mut client, kind, raw);
        let connection = accept(&fixture, &service, server);
        assert_eq!(connection.purpose(), purpose);
        assert_eq!(connection.request_bytes(), raw);
        assert_eq!(connection.peer().uid(), crate::native::uid());
        assert_eq!(connection.peer().gid(), nix::unistd::getgid().as_raw());
        assert_eq!(
            connection.peer().pid(),
            i32::try_from(std::process::id()).unwrap()
        );
        assert!(connection.same_runtime(&fixture.runtime));
        connection.reply_json(br#"{"actual":"reply"}"#).unwrap();
        assert_eq!(
            reply(&mut client),
            (b'J', br#"{"actual":"reply"}"#.to_vec())
        );
        assert_eq!(
            service.records.lock().unwrap().len(),
            1,
            "reply is not closure"
        );
        connection.close_for_worker().unwrap();
        assert!(service.records.lock().unwrap().is_empty());
    }
    service.close(end()).unwrap();
}

#[test]
fn legacy_tj_reader_still_refuses_other_verbs_and_service_reader_keeps_real_j() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'C', br#"{"action":"status"}"#);
    assert!(matches!(
        service
            .register_worker_connection(server)
            .unwrap()
            .receive(&fixture.collector, &super::launch::configuration()),
        Err(WorkerReportError::LaunchKind)
    ));
    assert_eq!(
        reply(&mut client),
        (b'E', b"Expected worker launch request".to_vec())
    );
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'J', br#"{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}"#);
    let AcceptedWorkerServiceConnection::Launch(connection) = service
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(&fixture.collector, &super::launch::configuration())
        .unwrap()
    else {
        panic!("genuine J remains genuine launch owner");
    };
    assert!(connection.same_runtime(&fixture.runtime));
    connection.close_socket_for_worker().unwrap();
    service.close(end()).unwrap();
}

#[test]
fn service_purposes_use_original_cap_and_return_slot_only_after_checked_close() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let mut connections = Vec::new();
    let mut clients = Vec::new();
    for _ in 0..service.limit {
        let (mut client, server) = fixture.sockets();
        send(&mut client, b'C', b"{}");
        connections.push(accept(&fixture, &service, server));
        clients.push(client);
    }
    let (_client, server) = fixture.sockets();
    assert!(matches!(
        service.register_worker_connection(server),
        Err(WorkerReportError::Capacity)
    ));
    connections.pop().unwrap().close_for_worker().unwrap();
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'G', b"{}");
    accept(&fixture, &service, server)
        .close_for_worker()
        .unwrap();
    for connection in connections {
        connection.close_for_worker().unwrap();
    }
    service.close(end()).unwrap();
}

#[test]
fn service_peer_refusal_precedes_payload_and_close_uncertainty_remains_opaque() {
    let fixture = Fixture::new();
    let mut wrong = fixture.service();
    wrong.uid = wrong.uid.wrapping_add(1);
    let wrong = Arc::new(wrong);
    let (mut client, server) = fixture.sockets();
    // Deliberately provide no frame; an attempted frame read would time out.
    assert!(matches!(
        wrong
            .register_worker_connection(server)
            .unwrap()
            .receive_service_for_worker(&fixture.collector, &super::launch::configuration()),
        Err(WorkerReportError::Peer)
    ));
    assert_eq!(reply(&mut client).0, b'E');
    wrong.close(end()).unwrap();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'C', b"{}");
    let connection = accept(&fixture, &service, server);
    CLOSE_REFUSAL.with(|flag| flag.set(true));
    assert!(connection.close_for_worker().is_err());
    assert!(service.close(end()).is_err());
    let (_client, server) = fixture.sockets();
    assert!(service.register_worker_connection(server).is_err());
    assert!(service.close(end()).is_err());
}

#[test]
fn service_origin_refuses_same_engine_foreign_registry_before_mutating_valid_owner() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let foreign = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'G', b"{}");
    let connection = accept(&fixture, &service, server);
    assert!(connection.same_runtime(&fixture.runtime));
    assert!(connection.assert_service(&foreign).is_err());
    assert!(!service.opaque.load(Ordering::Acquire));
    connection.assert_service(&service).unwrap();
    connection.reply_json(b"{}").unwrap();
    assert_eq!(reply(&mut client), (b'J', b"{}".to_vec()));
    connection.close_socket_for_worker().unwrap();
    service.close(end()).unwrap();
    foreign.close(end()).unwrap();
}

#[test]
fn service_socket_known_closed_retains_same_record_until_actual_hold_release() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'M', b"{}");
    let connection = accept(&fixture, &service, server);
    let mut hold = connection.retain_lifecycle().unwrap();
    assert!(matches!(
        connection.close_socket_for_worker().unwrap(),
        WorkerLaunchClose::SocketClosedLifecycleHeld
    ));
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert!(!service.opaque.load(Ordering::Acquire));
    assert!(service.close(end()).is_err());
    hold.release_for_worker().unwrap();
    service.close(end()).unwrap();
}

#[test]
fn service_dropped_resource_hold_stays_counted_and_unknown_close_keeps_origin() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'M', b"{}");
    let connection = accept(&fixture, &service, server);
    let hold = connection.retain_lifecycle().unwrap();
    connection.close_socket_for_worker().unwrap();
    drop(hold);
    assert!(service.close(end()).is_err());
    assert_eq!(service.records.lock().unwrap().len(), 1);
    drop(connection);
    drop(service);
    drop(fixture);
    // Use a different actual installed engine: the earlier held-record
    // quarantine must not make the consumed-close origin assertion pass.
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'G', b"{}");
    let connection = accept(&fixture, &service, server);
    let mut hold = connection.retain_lifecycle().unwrap();
    let origin = Arc::downgrade(fixture.runtime.installed_engine());
    CLOSE_REFUSAL.with(|flag| flag.set(true));
    assert!(connection.close_socket_for_worker().is_err());
    assert!(hold.release_for_worker().is_err());
    assert!(service.close(end()).is_err());
    drop(connection);
    drop(hold);
    drop(service);
    drop(fixture);
    assert!(
        origin.upgrade().is_some(),
        "same consumed-close origin remains quarantined"
    );
}
