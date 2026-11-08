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
