//! An actual successful Cold-finally LIVE epoch feeds the genuine later J;
//! no record fields, lifecycle entries, snapshots or permission flags are set.
use super::*;
use std::io::Read;

#[test]
fn actual_live_cold_finalize_then_new_j_reuses_same_resource_and_preserves_original_office() {
    crate::test_process::owning_case!(
        actual_live_cold_finalize_then_new_j_reuses_same_resource_and_preserves_original_office
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (_first_client, cold) = classified(&broker);
    let first = cold.prepare_cold().unwrap();
    let previous_j = first.scope.preparing.admitted.request.connection.clone();
    let original = first.started.clone();
    let closed = first.finalize_for_worker().unwrap();
    assert!(closed.storage_retained() && !closed.completed() && lease_held(&broker));
    tree.write("pane.out", b"0\n");
    let (mut client, socket) =
        crate::installing_broker::launch::tests::incoming_as(&broker, b'J', SID, true);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("actual later J");
    };
    let inspected = received.begin_ordinary().unwrap().prepare_prefix().unwrap();
    let claim = inspected.observed.claimed.storage.as_ref().unwrap();
    assert!(!claim.newly_claimed());
    let borrowed = broker
        .storage
        .runtime
        .borrow_started_laptop_storage(
            &original.created,
            &inspected
                .observed
                .claimed
                .preparing
                .admitted
                .request
                .connection,
        )
        .unwrap();
    assert_eq!(borrowed.paths(), claim.paths());
    drop(borrowed);
    let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
        panic!("actual existing Created resource is reusable");
    };
    let prepared = reuse.prepare_viewer().unwrap();
    let released = prepared.close_allocation().unwrap();
    let viewing = released.start_for_worker().unwrap();
    assert!(
        broker
            .storage
            .runtime
            .borrow_started_laptop_storage(&original.created, viewing.relay_connection())
            .is_err(),
        "consumed Created aliases cannot reopen actual storage"
    );
    assert!(!Arc::ptr_eq(&previous_j, viewing.relay_connection()));
    client.shutdown(std::net::Shutdown::Write).unwrap();
    let (viewing, outcome) = viewing.relay().into_parts();
    assert!(matches!(
        outcome,
        Ok(reverie_host::worker_reports::ViewerRelayEnd::PeerClosed)
    ));
    let result = viewing.finalize_for_worker().unwrap();
    assert!(result.storage_retained() && !result.completed());
    assert!(lease_held(&broker));
    client
        .set_read_timeout(Some(std::time::Duration::from_secs(1)))
        .unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert!(
        original
            .office
            ._phone
            .require_closed_for_resource(
                &broker.storage.runtime,
                &ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
    );
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("create\0"))
            .count(),
        1
    );
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("start\0"))
            .count(),
        1
    );
    // Fixture-only producer teardown; the genuine live resource stays held.
    original
        .office
        .close_for_stopped_source(super::super::super::tests::end())
        .unwrap();
}
