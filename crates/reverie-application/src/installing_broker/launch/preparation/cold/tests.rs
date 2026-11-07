//! Actual accepted J through ordinary Cold; only the engine child is synthetic.
use super::*;
use crate::reservation_gate::tests::Tree;
use reverie_host::worker_storage::StorageLease;
use std::fs;
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EID: &str = "11111111-2222-4333-8444-555555555555";
mod finalization;
mod started;
fn broker(tree: &Tree) -> InstallingBroker {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    raw["budgetMode"] = serde_json::json!("admission");
    raw["memoryMiB"] = serde_json::json!(512);
    let broker = super::super::tests::broker_configuration(tree, &raw);
    tree.write("company.json", &serde_json::to_vec(&serde_json::json!({"employees":[{"id":EID,"owner":null,"sessionId":SID,"desiredRunning":true}]})).unwrap());
    tree.write("cold-launch-control", b"fixed owned child mode");
    tree.write("inspect.out", b"initial optional missing observation");
    tree.write("inspect.out.status", b"7");
    broker
}
fn classified(broker: &InstallingBroker) -> (std::os::unix::net::UnixStream, ColdWorkerLaunch<'_>) {
    let (client, socket) =
        crate::installing_broker::launch::tests::incoming_as(broker, b'J', SID, false);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("actual accepted J");
    };
    let ClassifiedWorkerLaunch::Cold(cold) = received
        .begin_ordinary()
        .unwrap()
        .prepare_prefix()
        .unwrap()
        .classify_existing()
        .unwrap()
    else {
        panic!("actual initial Cold classification");
    };
    assert!(matches!(cold.target(), ExistingColdTarget::Absent));
    (client, cold)
}
fn lease_held(broker: &InstallingBroker) -> bool {
    match StorageLease::acquire_launch(
        broker.configuration().unwrap().configuration(),
        &ProfileSessionId::parse(SID).unwrap(),
    ) {
        Ok(lease) => {
            lease.close().unwrap();
            false
        }
        Err(_) => true,
    }
}
#[test]
fn accepted_cold_reaches_actual_created_pane_guard_and_registered_owner_with_same_j_and_lease() {
    crate::test_process::owning_case!(
        accepted_cold_reaches_actual_created_pane_guard_and_registered_owner_with_same_j_and_lease
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (_client, cold) = classified(&broker);
    let original = cold
        .inspected
        .observed
        .claimed
        .preparing
        .admitted
        .request
        .connection
        .clone();
    let closed = cold.prepare_cold().unwrap();
    assert!(Arc::ptr_eq(
        &original,
        &closed.scope.preparing.admitted.request.connection
    ));
    assert!(closed.scope.preparing.admitted.admission.is_none());
    assert!(closed.scope.active.is_some() && lease_held(&broker));
    let life = broker.installed.lifecycle().unwrap();
    assert!(
        matches!(&life.guard[0].owner, LaptopOwner::Started(actual) if Arc::ptr_eq(actual, &closed.started))
    );
    drop(life);
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    let mut at = 0;
    for phase in [
        "network\0inspect\0",
        "network\0create\0",
        "create\0--name\0",
        "start\0test-agent-",
        "new-session",
        "status\0off",
    ] {
        at += calls[at..].find(phase).unwrap() + phase.len();
    }
    assert!(tree.root.join("cold-pane-configured").is_file());
    assert!(closed.started.created.container_id().is_some());
    assert!(
        broker
            .close_command_telemetry(super::super::tests::end())
            .is_err(),
        "actual logical handler hold remains counted"
    );
    // Synthetic Office teardown only. The actual laptop lease/J/Hold stay
    // retained through process exit; this grants no production release credit.
    closed
        .started
        .office
        .close_for_stopped_source(super::super::tests::end())
        .unwrap();
    assert!(lease_held(&broker));
}
#[test]
fn nonzero_actual_create_retains_same_unknown_record_and_never_publishes_or_starts() {
    crate::test_process::owning_case!(
        nonzero_actual_create_retains_same_unknown_record_and_never_publishes_or_starts
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("cold-create-nonzero", b"actual fixed create child nonzero");
    let (_client, cold) = classified(&broker);
    let failure = cold.prepare_cold().err().unwrap();
    assert!(matches!(
        failure.owner.resources,
        Some(Resources::Network(_))
    ));
    assert!(failure.owner.lifecycle.is_none() && failure.owner.scope.active.is_some());
    assert!(lease_held(&broker));
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("create\0"))
            .count(),
        1
    );
    assert!(!calls.lines().any(|line| line.starts_with("start\0")));
    assert!(!tree.root.join("cold-started").exists());
    assert!(
        failure.owner.creation.is_none(),
        "unknown result cannot mint Created"
    );
    failure
        .owner
        .office
        .as_ref()
        .unwrap()
        .owner()
        .close_for_stopped_source(super::super::tests::end())
        .unwrap();
    assert!(lease_held(&broker));
}
