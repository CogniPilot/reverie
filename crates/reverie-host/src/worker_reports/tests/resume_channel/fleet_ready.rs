//! Same counted native socket; readiness never consumes consent or issues a
//! resource/website/owner proof. No production broker is contacted.
use super::*;

fn fleet(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
) -> (UnixStream, WorkerActorChannel) {
    let (mut client, server) = fixture.sockets();
    send(
        &mut client,
        b'Q',
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1,"replyVersion":2}"#,
    );
    let channel = accepted(fixture, service, server)
        .retain_fleet_maintenance_website_channel(&fixture.runtime)
        .ok()
        .unwrap();
    (client, channel)
}
fn greet(client: &mut UnixStream, channel: &mut WorkerActorChannel) {
    channel.pin_peer().unwrap();
    channel.greet(end()).unwrap();
    let mut raw = [0; b"FLEET_MAINTENANCE_CHANNEL_V2\n".len()];
    client.read_exact(&mut raw).unwrap();
    assert_eq!(&raw, b"FLEET_MAINTENANCE_CHANNEL_V2\n");
}
#[test]
fn fleet_ready_keeps_the_original_byte_record_and_hold_until_actual_read() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, mut channel) = fleet(&fixture, &service);
    let ungreeted = channel.fleet_maintenance_frame_ready(end());
    greet(&mut client, &mut channel);
    let original = service.records.lock().unwrap()[0].clone();
    let idle = channel.fleet_maintenance_frame_ready(end());
    let started = Instant::now();
    let deadline = started + Duration::from_secs(5);
    let writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2100));
        let sent = client.write_all(b"x");
        (client, sent)
    });
    let ready = loop {
        match channel.fleet_maintenance_frame_ready(deadline) {
            Ok(false) if Instant::now() < deadline => {}
            result => break result,
        }
    };
    let elapsed = started.elapsed();
    let same = Arc::ptr_eq(&service.records.lock().unwrap()[0], &original);
    let held = original.require_terminal_hold();
    let body = if matches!(ready, Ok(true)) {
        channel.receive_chunk(1, deadline)
    } else {
        Err(WorkerReportError::Unconfirmed)
    };
    let (client, sent) = writer.join().unwrap();
    let closed = channel.close_for_worker();
    let client_closed = super::super::super::record::close(client);
    let service_closed = service.close(end());
    closed.unwrap();
    client_closed.unwrap();
    service_closed.unwrap();
    held.unwrap();
    assert!(ungreeted.is_err() && same);
    assert!(!idle.unwrap() && ready.unwrap() && sent.is_ok());
    assert!(elapsed >= Duration::from_secs(2));
    assert_eq!(body.unwrap(), b"x");
}
#[test]
fn fleet_ready_refuses_ram_and_registration_while_existing_registration_poll_stays_available() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (client, mut ram) = channel(&fixture, &service);
    let ram_refused = ram.fleet_maintenance_frame_ready(end());
    ram.close_for_worker().unwrap();
    super::super::super::record::close(client).unwrap();
    let (mut client, server) = fixture.sockets();
    send(
        &mut client,
        b'B',
        br#"{"purpose":"host-pool-registration-v1","version":1}"#,
    );
    let mut registration = accepted(&fixture, &service, server)
        .retain_pool_registration_website_channel(&fixture.runtime)
        .ok()
        .unwrap();
    registration.pin_peer().unwrap();
    registration.greet(end()).unwrap();
    let mut raw = [0; b"POOL_REGISTRATION_CHANNEL_V1\n".len()];
    client.read_exact(&mut raw).unwrap();
    let b_refused = registration.fleet_maintenance_frame_ready(end());
    let b_idle = registration.pool_registration_frame_ready(end());
    registration.close_for_worker().unwrap();
    super::super::super::record::close(client).unwrap();
    service.close(end()).unwrap();
    assert!(ram_refused.is_err() && b_refused.is_err() && !b_idle.unwrap());
}
#[test]
fn fleet_ready_does_not_renew_an_expired_original_engine_stop() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, mut channel) = fleet(&fixture, &service);
    greet(&mut client, &mut channel);
    fixture
        .runtime
        .installed_engine()
        .expire_stop_for_owned_test();
    let refused = channel.fleet_maintenance_frame_ready(Instant::now() + Duration::from_secs(30));
    let closed = channel.close_for_worker();
    let client_closed = super::super::super::record::close(client);
    let service_closed = service.close(end());
    closed.unwrap();
    client_closed.unwrap();
    service_closed.unwrap();
    assert!(refused.is_err());
}
