//! Actual accepted records, kernel peer pin and counted holds. No installed
//! website, owner consent, RAM approval or global permission is modeled here.
use super::*;

#[test]
fn registration_transport_retains_same_record_with_distinct_greeting() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    let hello = br#"{"purpose":"host-pool-registration-v1","version":1}"#;
    send(&mut client, b'B', hello);
    let mut channel = accepted(&fixture, &service, server)
        .retain_pool_registration_website_channel(&fixture.runtime)
        .ok()
        .unwrap();
    let original = service.records.lock().unwrap()[0].clone();
    channel.pin_peer().unwrap();
    channel.greet(end()).unwrap();
    let expected = b"POOL_REGISTRATION_CHANNEL_V1\n";
    let mut raw = vec![0; expected.len()];
    client.read_exact(&mut raw).unwrap();
    assert_eq!(raw, expected);
    assert_eq!(channel.request_bytes(), hello);
    assert_eq!(channel.peer().pid(), std::process::id() as i32);
    original.require_terminal_hold().unwrap();
    assert!(matches!(
        channel.disconnect_for_worker().unwrap(),
        WorkerLaunchClose::SocketClosedLifecycleHeld
    ));
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    original.require_terminal_hold().unwrap();
    assert!(Arc::ptr_eq(&service.records.lock().unwrap()[0], &original));
    channel.close_for_worker().unwrap();
    assert!(service.records.lock().unwrap().is_empty());
    service.close(end()).unwrap();
}

#[test]
fn ram_and_registration_channels_refuse_cross_purpose_before_issuing_hold() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    for (kind, registration) in [(b'Q', true), (b'B', false)] {
        let (mut client, server) = fixture.sockets();
        send(&mut client, kind, b"{}");
        let connection = accepted(&fixture, &service, server);
        let mut failure = if registration {
            connection.retain_pool_registration_website_channel(&fixture.runtime)
        } else {
            connection.retain_resource_website_channel(&fixture.runtime)
        }
        .err()
        .unwrap();
        assert!(matches!(failure.cause(), WorkerReportError::Peer));
        let original = service.records.lock().unwrap()[0].clone();
        assert!(matches!(
            *original
                .lifecycle_until(&super::super::super::budget::CleanupBudget::bounded(
                    &service,
                    end()
                ))
                .unwrap(),
            super::super::super::retention::LifecycleHoldState::Unissued
        ));
        failure.close_for_worker().unwrap();
        assert!(service.records.lock().unwrap().is_empty());
    }
    service.close(end()).unwrap();
}

#[test]
fn failed_registration_constructor_reports_external_hold_until_actual_release() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let original_end = end();
    let (mut client, server) = fixture.sockets();
    send(
        &mut client,
        b'B',
        br#"{"purpose":"host-pool-registration-v1","version":1}"#,
    );
    let connection = accepted(&fixture, &service, server);
    let mut hold = connection.retain_lifecycle().unwrap();
    let original = service.records.lock().unwrap()[0].clone();
    // The actual second Hold mint refuses. This failure owns the connection,
    // but never acquired the external logical Hold retained above.
    let mut failure = connection
        .retain_pool_registration_website_channel(&fixture.runtime)
        .err()
        .unwrap();
    let typed = failure.close_channel_component_for_worker();
    let unit = failure.close_for_worker();
    let still_held = original.require_terminal_hold();
    let same_record = {
        let records = service.records.lock().unwrap();
        records.len() == 1 && Arc::ptr_eq(&records[0], &original)
    };
    let eof = client.read(&mut [0; 1]);
    let released = hold.release(original_end);
    let settled = failure.close_channel_component_for_worker();
    let unit_settled = failure.close_for_worker();
    drop(failure);
    let closed = service.close(original_end);
    let client_closed = super::super::super::record::close(client);
    // All original finalizers run before any regression verdict.
    assert!(
        released.is_ok() && closed.is_ok() && client_closed.is_ok(),
        "cleanup: {released:?} {closed:?} {client_closed:?}"
    );
    assert_eq!(typed.unwrap(), WorkerLaunchClose::SocketClosedLifecycleHeld);
    assert!(matches!(unit, Err(WorkerReportError::LifecycleRetained)));
    still_held.unwrap();
    assert!(same_record);
    assert_eq!(eof.unwrap(), 0);
    assert_eq!(settled.unwrap(), WorkerLaunchClose::Complete);
    unit_settled.unwrap();
}
