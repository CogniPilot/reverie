//! Genuine accepted B records and external logical Holds. No successful OS
//! offer, attested website, consent or global capability is manufactured.
use super::super::tests::Fixture;
use super::*;
use std::io::Read;

const HELLO: &[u8] = br#"{"purpose":"host-pool-registration-v1","version":1}"#;

#[test]
fn actual_frame_close_preserves_held_incoming_and_failed_b_transports() {
    crate::test_process::owning_case!(
        actual_frame_close_preserves_held_incoming_and_failed_b_transports
    );
    for failed in [false, true] {
        let mut fixture = Fixture::new();
        let original_end = Instant::now() + Duration::from_secs(3);
        let (mut client, connection) = fixture.accept(b'B', HELLO);
        let mut hold = connection.retain_lifecycle().unwrap();
        let mut frame = if failed {
            // A real second Hold mint refuses before program/private effects.
            let entry = fixture
                .broker
                .prepare_pool_registration_website(connection)
                .err()
                .unwrap();
            let ResourceActorFailure { frame, .. } = *entry;
            frame
        } else {
            Frame::incoming(
                &fixture.broker,
                connection,
                WebsitePurpose::PoolRegistration,
                original_end,
            )
        };
        let first = frame.close(original_end);
        let retained_transport = if failed {
            matches!(frame.transport, Transport::Failed(_))
        } else {
            matches!(frame.transport, Transport::Incoming(_))
        };
        let eof = client.read(&mut [0; 1]);
        let released = hold.release(original_end);
        let second = frame.close(original_end);
        let known_closed = matches!(frame.transport, Transport::Closed);
        drop(frame);
        drop(hold);
        let reports = fixture.broker.reports.close(original_end);
        let client_close = nix::unistd::close(client);
        fixture.retained = reports.is_err();
        drop(fixture);
        assert!(
            released.is_ok() && reports.is_ok() && client_close.is_ok(),
            "cleanup: {released:?} {reports:?} {client_close:?}"
        );
        assert_eq!(first.unwrap(), WorkerLaunchClose::SocketClosedLifecycleHeld);
        assert!(
            retained_transport,
            "held transport must stay with the same Frame"
        );
        assert_eq!(eof.unwrap(), 0);
        assert_eq!(second.unwrap(), WorkerLaunchClose::Complete);
        assert!(known_closed);
    }
}

#[test]
fn actual_failed_b_entry_keeps_external_hold_until_same_failure_can_settle() {
    crate::test_process::owning_case!(
        actual_failed_b_entry_keeps_external_hold_until_same_failure_can_settle
    );
    let mut fixture = Fixture::new();
    let original_end = Instant::now() + Duration::from_secs(3);
    let (mut client, connection) = fixture.accept(b'B', HELLO);
    let mut hold = connection.retain_lifecycle().unwrap();
    let entry = fixture
        .broker
        .prepare_pool_registration_website(connection)
        .err()
        .unwrap();
    let initial_failed = matches!(entry.frame.transport, Transport::Failed(_));
    // Negative cleanup composition of that actual failed entry. This creates
    // no valid offer/guard and does not bypass the production entry checks.
    let failure = Box::new(PoolRegistrationFailure {
        owner: Owner::Entry(entry),
        offer: None,
        primary: Cause::Refused("POOL_REGISTRATION_NATIVE_ENTRY_RETAINED"),
        first_cleanup: None,
        cleanup_failures: 0,
        deadline: original_end,
    });
    let (retained, premature) = match failure.settle_for_worker() {
        Err(owner) => (Some(owner), false),
        Ok(_) => (None, true),
    };
    let retained_transport = matches!(retained.as_ref().map(|owner| &owner.owner), Some(Owner::Entry(entry)) if matches!(entry.frame.transport, Transport::Failed(_)));
    let eof = client.read(&mut [0; 1]);
    let blocked = fixture.broker.reports.close(original_end);
    let released = hold.release(original_end);
    let settled = retained.map(|owner| owner.settle_for_worker());
    let diagnostic = match &settled {
        Some(Ok(closed)) => Some(closed.to_string()),
        _ => None,
    };
    let settled_known = matches!(&settled, Some(Ok(_)));
    drop(settled);
    drop(hold);
    let reports = fixture.broker.reports.close(original_end);
    let client_close = nix::unistd::close(client);
    fixture.retained = reports.is_err();
    drop(fixture);
    assert!(
        released.is_ok() && reports.is_ok() && client_close.is_ok(),
        "cleanup: {released:?} {reports:?} {client_close:?}"
    );
    assert!(
        initial_failed && !premature && retained_transport,
        "actual failed constructor cannot erase the external Hold"
    );
    assert_eq!(eof.unwrap(), 0);
    assert!(blocked.is_err());
    assert!(settled_known);
    let diagnostic = diagnostic.unwrap();
    assert!(diagnostic.contains("RESOURCE_ACTOR_CHANNEL_ORIGIN"));
    assert!(diagnostic.contains("POOL_REGISTRATION_LIFECYCLE_HELD"));
}
