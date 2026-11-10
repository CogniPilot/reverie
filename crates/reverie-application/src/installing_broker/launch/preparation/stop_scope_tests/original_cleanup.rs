//! Actual accepted J/early Hold and canonical counted Q selection. This is a
//! lower provenance/admission control, not OS consent, physical Job joining,
//! original resource closure or a drained-fleet certificate.
use super::*;
use reverie_contracts::reservation_control::PoolTransitionSelection;
use reverie_core::operations::{JournalDigest, JournalId};
use reverie_host::worker_reports::{AcceptedWorkerServiceConnection, WorkerActorChannel};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
};
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
fn target(broker: &InstallingBroker) -> WorkerContainerName {
    WorkerContainerName::for_session(
        broker.configuration().unwrap().envelope().base(),
        &ProfileSessionId::parse(SID).unwrap(),
    )
}

fn preparing(broker: &InstallingBroker) -> (UnixStream, Box<PreparationFailure<'_>>) {
    let (client, admitted) = super::super::tests::incoming(broker, SID);
    // The actual public prefix/finalizer closes allocation, metadata and
    // socket while retaining its actual employee claim and handler Hold.
    let failure = admitted
        .prepare_prefix()
        .unwrap()
        .abort(super::super::tests::end());
    (client, failure)
}
fn q(broker: &InstallingBroker) -> (UnixStream, WorkerActorChannel) {
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
        .unwrap();
    let raw = br#"{"purpose":"resource-fleet-maintenance-v1","version":1}"#;
    client
        .write_all(
            &reverie_core::worker_wire::WorkerFrameHeader::for_payload(b'Q', raw.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(raw).unwrap();
    let AcceptedWorkerServiceConnection::Service(connection) = broker
        .reports
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(
            &broker.telemetry,
            broker.configuration().unwrap().configuration(),
        )
        .unwrap()
    else {
        panic!("actual Q")
    };
    let mut channel = connection
        .retain_fleet_maintenance_website_channel(&broker.storage.runtime)
        .ok()
        .unwrap();
    channel.pin_peer().unwrap();
    channel.greet(super::super::tests::end()).unwrap();
    let mut greeting = [0; b"FLEET_MAINTENANCE_CHANNEL_V1\n".len()];
    client.read_exact(&mut greeting).unwrap();
    assert_eq!(&greeting, b"FLEET_MAINTENANCE_CHANNEL_V1\n");
    (client, channel)
}
fn selection(broker: &InstallingBroker) -> PoolTransitionSelection {
    PoolTransitionSelection::new(
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000001").unwrap(),
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000002").unwrap(),
        JournalDigest::parse(&"a".repeat(64)).unwrap(),
        JournalDigest::parse(&"b".repeat(64)).unwrap(),
        JournalDigest::parse(&"c".repeat(64)).unwrap(),
        JournalDigest::parse(
            &reverie_contracts::worker_config::config_digest(
                broker.configuration().unwrap().configuration(),
            )
            .to_hex(),
        )
        .unwrap(),
    )
}
#[test]
fn same_original_after_eof_can_cleanup_under_its_fence_but_late_equal_sid_and_foreign_target_cannot()
 {
    crate::test_process::owning_case!(same_original_after_eof_can_cleanup_under_its_fence_but_late_equal_sid_and_foreign_target_cannot);
    let tree = Tree::new();
    tree.write("company.json", br#"{"employees":[]}"#);
    tree.write("inspect.out", b"actual optional missing fixture");
    tree.write("inspect.out.status", b"7");
    let broker = configured(&tree);
    let (client, original) = preparing(&broker);
    let (q_client, mut q) = q(&broker);
    let drain = q
        .retain_other_original_handlers(
            &broker.reports,
            &broker.storage.runtime,
            super::super::tests::end(),
        )
        .unwrap();
    // SAME SID is deliberately insufficient: this actual Record was accepted
    // after the canonical selection, before the denial fence was published.
    let (late_client, late) = super::super::tests::incoming(&broker, SID);
    let late_connection = late.request.connection.clone();
    let mut late_hold = late_connection.retain_lifecycle().unwrap();
    late.close(super::super::tests::end()).unwrap();
    let mut fence = broker
        .resource_reservations()
        .unwrap()
        .unwrap()
        .establish_pool_transition(
            &selection(&broker),
            crate::reservation_gate::AdmissionBounds::default(),
        )
        .unwrap();
    broker
        .bind_pool_original_cleanup(&mut fence, &q, &drain)
        .unwrap();
    let pending = tree.root.join("state/resource-reservation-control.pending");
    let before = std::fs::read(&pending).unwrap();
    let ordinary = broker.admit_ordinary_stop(&target(&broker)).is_err();
    let rejected_late = broker
        .admit_original_handler_cleanup(&late_connection, &target(&broker))
        .is_err();
    let foreign = WorkerContainerName::for_session(
        broker.configuration().unwrap().envelope().base(),
        &ProfileSessionId::parse("99999999-1111-4111-8111-111111111111").unwrap(),
    );
    let rejected_target = original.preparing.admit_original_cleanup(&foreign).is_err();
    let (allowed, held) = match original.preparing.admit_original_cleanup(&target(&broker)) {
        Ok(admission) => {
            let held = AdmissionLock::acquire(&ReservationConfiguration::capture(
                broker.configuration().unwrap().configuration().clone(),
            ))
            .is_err();
            let result = admission.close();
            (result, held)
        }
        Err(cause) => (Err(cause), false),
    };
    let mut available = AdmissionLock::acquire(&ReservationConfiguration::capture(
        broker.configuration().unwrap().configuration().clone(),
    ))
    .unwrap();
    available.close().unwrap();
    let after = std::fs::read(&pending).unwrap();
    let calls = std::fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    super::super::prefix_tests::configured::fixture_close(original);
    late_hold.release(super::super::tests::end()).unwrap();
    drop(late_connection);
    q.close_for_worker().unwrap();
    for client in [client, late_client, q_client] {
        nix::unistd::close(client).unwrap();
    }
    // No drain settlement or Job-join credit is invented for these lower
    // accepted prefixes. Its default Drop retains unresolved provenance.
    drop(drain);
    drop(fence);
    broker
        .close_command_telemetry(super::super::tests::end())
        .unwrap();
    broker
        .storage
        .runtime
        .close(super::super::tests::end())
        .unwrap();
    assert!(ordinary && rejected_late && rejected_target);
    assert!(held, "actual original cleanup owns the R flock");
    allowed.unwrap();
    assert_eq!(before, after);
    assert!(!calls.lines().any(|line| line.starts_with("stop\0")
        || line.starts_with("kill\0")
        || line.starts_with("create\0")));
}
