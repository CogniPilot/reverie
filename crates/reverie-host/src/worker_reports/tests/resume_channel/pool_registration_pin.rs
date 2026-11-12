//! Real counted B records and their sole kernel peer. These controls do not
//! construct an attested website, consent, installation or administration grant.
use super::*;

fn ungreeted(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
) -> (UnixStream, WorkerActorChannel) {
    let (mut client, server) = fixture.sockets();
    send(
        &mut client,
        b'B',
        br#"{"purpose":"host-pool-registration-v1","version":1}"#,
    );
    let mut channel = accepted(fixture, service, server)
        .retain_pool_registration_website_channel(&fixture.runtime)
        .ok()
        .unwrap();
    channel.pin_peer().unwrap();
    (client, channel)
}
fn registration_channel(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
) -> (UnixStream, WorkerActorChannel) {
    let (mut client, mut channel) = ungreeted(fixture, service);
    channel.greet(end()).unwrap();
    let mut greeting = [0; 29];
    client.read_exact(&mut greeting).unwrap();
    assert_eq!(&greeting, b"POOL_REGISTRATION_CHANNEL_V1\n");
    (client, channel)
}
#[test]
fn pins_require_distinct_original_purpose_greeting_and_same_service() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let foreign = Arc::new(fixture.service());
    let (mut client, mut registration) = ungreeted(&fixture, &service);
    let before_greeting = registration.retain_pool_registration_pin(&service);
    registration.greet(end()).unwrap();
    let mut greeting = [0; 29];
    client.read_exact(&mut greeting).unwrap();
    let cross_q = registration.retain_resource_journal_pin(&service);
    let wrong_service = registration.retain_pool_registration_pin(&foreign);
    let registration_pin = registration.retain_pool_registration_pin(&service).unwrap();
    let b_current = registration_pin.assert_current();
    let (q_client, mut q_channel) = channel(&fixture, &service);
    let cross_b = q_channel.retain_pool_registration_pin(&service);
    let q_pin = q_channel.retain_resource_journal_pin(&service).unwrap();
    let q_current = q_pin.assert_current();
    let q_client_closed = super::super::super::record::close(q_client);
    let q_closed = q_channel.close_for_worker();
    let client_closed = super::super::super::record::close(client);
    let registration_closed = registration.close_for_worker();
    let service_closed = service.close(end());
    let foreign_closed = foreign.close(end());
    assert!(before_greeting.is_err());
    assert!(cross_q.is_err() && cross_b.is_err() && wrong_service.is_err());
    b_current.unwrap();
    q_current.unwrap();
    q_client_closed.unwrap();
    q_closed.unwrap();
    client_closed.unwrap();
    registration_closed.unwrap();
    service_closed.unwrap();
    foreign_closed.unwrap();
    assert!(registration_pin.assert_current().is_err() && q_pin.assert_current().is_err());
}
#[test]
fn registration_pin_refuses_empty_socket_eof_without_replacing_original_peer() {
    if crate::test_process::isolate_case(concat!(
        "worker_reports::tests::resume_channel::pool_registration_pin::",
        "registration_pin_refuses_empty_socket_eof_without_replacing_original_peer"
    )) {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (client, mut channel) = registration_channel(&fixture, &service);
    let pin = channel.retain_pool_registration_pin(&service).unwrap();
    let original = service.records.lock().unwrap()[0].clone();
    let current = pin.assert_current();
    let client_closed = super::super::super::record::close(client);
    let ended = pin.assert_current();
    let held = original.require_terminal_hold();
    let disconnected = channel.disconnect_for_worker();
    let after_disconnect = pin.assert_current();
    let held_after_disconnect = original.require_terminal_hold();
    let channel_closed = channel.close_for_worker();
    let service_closed = service.close(end());
    current.unwrap();
    client_closed.unwrap();
    assert!(ended.is_err() && after_disconnect.is_err());
    held.unwrap();
    assert!(matches!(
        disconnected.unwrap(),
        WorkerLaunchClose::SocketClosedLifecycleHeld
    ));
    held_after_disconnect.unwrap();
    channel_closed.unwrap();
    service_closed.unwrap();
    assert!(service.records.lock().unwrap().is_empty());
    assert!(pin.assert_current().is_err());
}
#[test]
fn registration_pin_refuses_buffered_fin_while_legacy_input_still_drains() {
    if crate::test_process::isolate_case(concat!(
        "worker_reports::tests::resume_channel::pool_registration_pin::",
        "registration_pin_refuses_buffered_fin_while_legacy_input_still_drains"
    )) {
        return;
    }
    let fixture = Fixture::new();
    for half_close in [true, false] {
        let service = Arc::new(fixture.service());
        let (client, mut channel) = registration_channel(&fixture, &service);
        let mut client = Some(client);
        let pin = channel.retain_pool_registration_pin(&service).unwrap();
        let first_written = client.as_mut().unwrap().write_all(b"x");
        let open = pin.assert_current();
        let first = channel.receive_chunk(1, end());
        let second_written = client.as_mut().unwrap().write_all(b"y");
        let shutdown = if half_close {
            client
                .as_ref()
                .unwrap()
                .shutdown(std::net::Shutdown::Write)
                .map_err(WorkerReportError::Io)
        } else {
            super::super::super::record::close(client.take().unwrap())
        };
        let legacy = channel.peer_ended();
        let closed = pin.assert_current();
        let second = channel.receive_chunk(1, end());
        let client_closed = client.map_or(Ok(()), super::super::super::record::close);
        let channel_closed = channel.close_for_worker();
        let service_closed = service.close(end());
        first_written.unwrap();
        open.unwrap();
        assert_eq!(first.unwrap(), b"x");
        second_written.unwrap();
        shutdown.unwrap();
        assert!(!legacy.unwrap());
        assert!(
            closed.is_err(),
            "the same peer process remains alive behind actual socket FIN"
        );
        assert_eq!(second.unwrap(), b"y");
        client_closed.unwrap();
        channel_closed.unwrap();
        service_closed.unwrap();
    }
}
#[test]
fn registration_pin_observes_same_member_and_socket_contention_without_waiting() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (client, mut channel) = registration_channel(&fixture, &service);
    let pin = channel.retain_pool_registration_pin(&service).unwrap();
    let original = service.records.lock().unwrap()[0].clone();
    let records = service.records.lock().unwrap();
    let member_start = Instant::now();
    let member_busy = pin.assert_current();
    let member_elapsed = member_start.elapsed();
    drop(records);
    let stream = original.terminal_stream().unwrap();
    let socket_start = Instant::now();
    let socket_busy = pin.assert_current();
    let socket_elapsed = socket_start.elapsed();
    drop(stream);
    let current = pin.assert_current();
    let held = original.require_terminal_hold();
    let client_closed = super::super::super::record::close(client);
    let channel_closed = channel.close_for_worker();
    let service_closed = service.close(end());
    assert!(member_busy.is_err() && socket_busy.is_err());
    assert!(member_elapsed < Duration::from_secs(1) && socket_elapsed < Duration::from_secs(1));
    current.unwrap();
    held.unwrap();
    client_closed.unwrap();
    channel_closed.unwrap();
    service_closed.unwrap();
}
