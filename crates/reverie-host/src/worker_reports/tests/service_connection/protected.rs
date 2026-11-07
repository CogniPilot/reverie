//! Actual L Record keeps one cap/physical socket through typed delegation.
use super::*;
const BODY: &[u8] = br#"{"reference":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","request":{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}}"#;
#[test]
fn actual_l_delegation_keeps_original_socket_and_cap_and_refuses_ordinary_origin() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let other_service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'L', BODY);
    let source = accept(&fixture, &service, server);
    let protected = source
        .decode_protected_launch(&super::super::launch::configuration())
        .ok()
        .unwrap();
    protected.assert_service(&service).unwrap();
    assert!(protected.assert_service(&other_service).is_err());
    assert_eq!(
        protected.peer().pid(),
        i32::try_from(std::process::id()).unwrap()
    );
    assert_eq!(
        protected.reference().as_str(),
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );
    let held = protected.retain_for_qualification().ok().unwrap();
    held.assert_current(&fixture.runtime).unwrap();
    let (connection, _, _, mut hold) = held.into_parts();
    assert!(connection.assert_ordinary_origin().is_err());
    connection.assert_protected_origin().unwrap();
    connection.assert_open(&fixture.runtime).unwrap();
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert_eq!(
        connection.close_socket_for_worker().unwrap(),
        WorkerLaunchClose::SocketClosedLifecycleHeld
    );
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert!(service.close(end()).is_err());
    hold.release_for_worker().unwrap();
    service.close(end()).unwrap();
    other_service.close(end()).unwrap();
}
#[test]
fn wrong_purpose_and_invalid_l_decode_return_the_original_direct_owner_for_checked_close() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    for (kind, payload) in [(b'C', BODY), (b'L', b"{}".as_slice())] {
        let (mut client, server) = fixture.sockets();
        send(&mut client, kind, payload);
        let source = accept(&fixture, &service, server);
        let failure = source
            .decode_protected_launch(&super::super::launch::configuration())
            .err()
            .unwrap();
        let (connection, _) = failure.into_parts();
        assert_eq!(connection.request_bytes(), payload);
        assert_eq!(service.records.lock().unwrap().len(), 1);
        connection.close_for_worker().unwrap();
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
        assert!(service.records.lock().unwrap().is_empty());
    }
    service.close(end()).unwrap();
}
