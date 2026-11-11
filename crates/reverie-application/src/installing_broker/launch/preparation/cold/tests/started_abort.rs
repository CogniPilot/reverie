//! Actual accepted handler, Created/start, Office and holds with controlled
//! Engine observations. This joins the pre-memory finalizer, not a native
//! controller grant; the Host separately tests its cleanup-only refusal phase.
use super::*;
use std::{io::Read, os::unix::net::UnixStream, time::Duration};

fn started_before_memory(broker: &InstallingBroker) -> (UnixStream, ColdBody<'_>) {
    let (client, cold) = classified(broker);
    let mut owner = ColdBody::from_classified(cold);
    owner.stop_existing().unwrap();
    owner.copy_nix().unwrap();
    owner.prepare_network().unwrap();
    let network = owner.network();
    let connection = owner.scope.preparing.admitted.request.connection.clone();
    let reverie_host::worker_laptop::LaptopCreation::Created(created) = network
        .create_for_connection(broker.command_telemetry(), &connection)
        .unwrap()
    else {
        panic!("actual controlled Created");
    };
    network.publish_created(&created).unwrap();
    let reverie_host::worker_laptop::ContainerStart::Started(started) =
        network.start_for_connection(&created, &connection).unwrap()
    else {
        panic!("actual controlled start");
    };
    owner.creation = Some(CreationContext {
        created,
        started: Some(started),
        pane: None,
    });
    drop(owner.lifecycle.take());
    (client, owner)
}

#[test]
fn pre_memory_known_abort_releases_real_handler_hold_only_after_exact_created_cleanup() {
    crate::test_process::owning_case!(
        pre_memory_known_abort_releases_real_handler_hold_only_after_exact_created_cleanup
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (mut client, owner) = started_before_memory(&broker);
    let office = owner.office.as_ref().unwrap().owner().clone();
    let cid = owner
        .creation
        .as_ref()
        .unwrap()
        .created
        .container_id()
        .unwrap()
        .as_str()
        .to_owned();
    assert!(lease_held(&broker));
    assert!(
        owner.scope.active.is_some(),
        "original accepted handler hold remains owned"
    );
    let closed = Box::new(ColdLaunchFailure {
        owner,
        cause: ColdError::Refused("OWNED_CALLER_REFUSED_BEFORE_MEMORY"),
    })
    .finalize_for_worker()
    .unwrap();
    assert!(!closed.completed() && !closed.storage_retained() && closed.primary_error().is_some());
    assert!(!lease_held(&broker));
    assert!(tree.root.join("cold-stopped").is_file());
    office
        ._phone
        .require_closed_for_resource(
            &broker.storage.runtime,
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(
        calls
            .lines()
            .any(|line| line == format!("stop\0--time\0{}\0{cid}", 2))
    );
    assert!(!calls.contains("new-session"), "no CLI pane was started");
    broker
        .close_command_telemetry(super::super::super::tests::end())
        .unwrap();
}

#[test]
fn pre_memory_abort_with_unconfirmed_created_stop_retains_real_handler_hold() {
    crate::test_process::owning_case!(
        pre_memory_abort_with_unconfirmed_created_stop_retains_real_handler_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (mut client, owner) = started_before_memory(&broker);
    let office = owner.office.as_ref().unwrap().owner().clone();
    tree.write("cold-stop-refused", b"owned stop and kill both refuse");
    let retained = Box::new(ColdLaunchFailure {
        owner,
        cause: ColdError::Refused("OWNED_CALLER_REFUSED_BEFORE_MEMORY"),
    })
    .finalize_for_worker()
    .err()
    .unwrap();
    assert!(retained.cleanup_error_count() > 0 && lease_held(&broker));
    assert!(!tree.root.join("cold-stopped").exists());
    assert!(
        broker
            .close_command_telemetry(super::super::super::tests::end())
            .is_err()
    );
    client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    // Fixture-only Office teardown supplies no stopped/hold-release proof.
    office
        .close_for_stopped_source(super::super::super::tests::end())
        .unwrap();
    assert!(lease_held(&broker));
}
