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
