//! Real incoming records. Negative installation entry never creates a native
//! website, current owner, RAM admission or global administration capability.
use super::*;

#[test]
fn installation_and_ram_entry_points_keep_purpose_and_native_setup_separate() {
    crate::test_process::owning_case!(
        installation_and_ram_entry_points_keep_purpose_and_native_setup_separate
    );
    let fixture = Fixture::new();
    let ram = br#"{"purpose":"resource-ram-pool-v2","version":2}"#;
    let registration = br#"{"purpose":"host-pool-registration-v1","version":1}"#;
    for (kind, hello, is_registration, expected) in [
        (b'Q', ram.as_slice(), true, "RESOURCE_ACTOR_CHANNEL_ORIGIN"),
        (
            b'B',
            registration.as_slice(),
            false,
            "RESOURCE_ACTOR_CHANNEL_ORIGIN",
        ),
        (b'B', ram.as_slice(), true, "RESOURCE_RAM_BINDING_CHANGED"),
        (
            b'B',
            registration.as_slice(),
            true,
            "RESOURCE_INSTALL_FIXED_PATH",
        ),
    ] {
        let (mut client, connection) = fixture.accept(kind, hello);
        let mut failure = if is_registration {
            fixture
                .broker
                .prepare_pool_registration_website(connection)
                .err()
                .unwrap()
        } else {
            fixture
                .broker
                .prepare_resource_website(connection)
                .err()
                .unwrap()
        };
        assert_eq!(failure.cause().code(), expected);
        assert!(failure.frame.bindings.is_none());
        close(&mut failure, &mut client);
    }
    assert!(
        !fixture.tree.root.join("calls.txt").exists(),
        "missing native installation must refuse before engine queries"
    );
}

#[test]
fn actual_b_refusal_retains_same_lifecycle_hold_until_real_release_before_component_close() {
    crate::test_process::owning_case!(
        actual_b_refusal_retains_same_lifecycle_hold_until_real_release_before_component_close
    );
    let mut fixture = Fixture::new();
    let original_end = end();
    let hello = br#"{"purpose":"host-pool-registration-v1","version":1}"#;
    let (mut client, connection) = fixture.accept(b'B', hello);
    let mut hold = connection.retain_lifecycle().unwrap();
    let failure = fixture.broker.refuse_pool_registration(
        connection,
        BrokerInstallationOfferCause::Refused("POOL_INSTALLATION_OFFER_REQUIRED"),
        original_end,
    );
    let (retained, premature) = match failure.settle_for_worker() {
        Err(owner) => (Some(owner), false),
        Ok(_) => (None, true),
    };
    let eof = client.read(&mut [0; 1]);
    // This real closed socket's SAME held record must still block service close.
    let blocked = fixture.broker.reports.close(original_end);
    let released = hold.release(original_end);
    let settled = retained.map(|owner| owner.settle_for_worker());
    let diagnostic = match &settled {
        Some(Ok(closed)) => Some(closed.to_string()),
        _ => None,
    };
    let reports_closed = fixture.broker.reports.close(original_end);
    let client_closed = nix::unistd::close(client);
    let settled_known = matches!(&settled, Some(Ok(_)));
    drop(settled);
    drop(hold);
    fixture.retained = reports_closed.is_err();
    drop(fixture);
    // All actual owner cleanup runs before the regression verdict, including
    // a falsely positive first close. The original bound is never renewed.
    released.unwrap();
    reports_closed.unwrap();
    client_closed.unwrap();
    assert!(
        !premature,
        "physical socket close cannot settle a real held B record"
    );
    assert_eq!(eof.unwrap(), 0);
    assert!(blocked.is_err());
    assert!(
        settled_known,
        "same failure must settle after actual Hold release"
    );
    let diagnostic = diagnostic.unwrap();
    assert!(diagnostic.contains("POOL_INSTALLATION_OFFER_REQUIRED"));
    assert!(diagnostic.contains("POOL_REGISTRATION_LIFECYCLE_HELD"));
}
