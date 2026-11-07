//! An actual successful Cold-finally LIVE epoch feeds the genuine later J;
//! no record fields, lifecycle entries, snapshots or permission flags are set.
use super::*;
use crate::installing_broker::launch::preparation::tests::incoming;
use std::io::Read;
#[test]
fn actual_wrong_j_transfer_returns_all_once_observed_inputs_before_same_owner_success() {
    crate::test_process::owning_case!(
        actual_wrong_j_transfer_returns_all_once_observed_inputs_before_same_owner_success
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (_first_client, cold) = classified(&broker);
    let first = cold.prepare_cold().unwrap();
    let original = first.started.clone();
    assert!(first.finalize_for_worker().unwrap().storage_retained());
    tree.write("pane.out", b"0\n");
    let foreign_tree = Tree::new();
    let foreign = super::broker(&foreign_tree);
    let (_other_client, admitted) = incoming(&foreign, SID);
    let mut other = PreparingWorkerLaunch::enter(admitted).unwrap();
    // Both genuine negative-purpose J owners are admitted before the positive
    // prefix holds its lifecycle. No same-thread recursive lock is attempted.
    let (_intruder_client, admitted) = incoming(&broker, SID);
    let mut intruder = PreparingWorkerLaunch::enter(admitted).unwrap();
    let (_client, admitted) = incoming(&broker, SID);
    let inspected = admitted.prepare_prefix().unwrap();
    let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
        panic!("actual reuse");
    };
    let ReusableWorkerLaunch {
        receipt,
        inspected,
        resources,
    } = reuse;
    let InspectedWorkerLaunch { observed, previous } = inspected;
    let observe::ObservedWorkerLaunch {
        mut claimed,
        current,
        plan,
    } = observed;
    let failure = broker
        .storage
        .runtime
        .transfer_started_laptop_relay(
            &original.created,
            plan,
            previous.unwrap(),
            receipt.unwrap(),
            &other.admitted.request.connection,
        )
        .err()
        .unwrap();
    let (plan, previous, receipt, cause) = failure.into_parts();
    assert_eq!(cause.to_string(), "VIEWER_CONNECTION_RUNTIME_CHANGED");
    previous
        .assert_plan(&broker.storage.runtime, &plan)
        .unwrap();
    assert_eq!(plan.storage(), claimed.storage.as_ref().unwrap().paths());
    assert!(!receipt.exists() && lease_held(&broker));
    let borrowed = broker
        .storage
        .runtime
        .borrow_started_laptop_storage(
            &original.created,
            &claimed.preparing.admitted.request.connection,
        )
        .unwrap();
    assert_eq!(borrowed.paths(), plan.storage());
    drop(borrowed);
    other
        .admitted
        .request
        .connection
        .close_socket_for_worker()
        .unwrap();
    other.hold.as_mut().unwrap().release_for_worker().unwrap();
    foreign
        .close_command_telemetry(super::super::super::tests::end())
        .unwrap();
    let refusal = claimed
        .storage
        .take()
        .unwrap()
        .retain_existing_relay_for_connection(
            plan,
            previous,
            receipt,
            &intruder.admitted.request.connection,
        )
        .err()
        .unwrap();
    let (storage, plan, _derived_request_data, previous, receipt, cause) = refusal.into_parts();
    assert_eq!(cause.to_string(), "WORKER_STARTED_CONNECTION_CHANGED");
    claimed.storage = Some(storage);
    intruder
        .admitted
        .request
        .connection
        .close_socket_for_worker()
        .unwrap();
    intruder
        .hold
        .as_mut()
        .unwrap()
        .release_for_worker()
        .unwrap();
    let reuse = ReusableWorkerLaunch {
        receipt: Some(receipt),
        inspected: InspectedWorkerLaunch {
            observed: observe::ObservedWorkerLaunch {
                claimed,
                current,
                plan,
            },
            previous: Some(previous),
        },
        resources,
    };
    let result = reuse
        .prepare_viewer()
        .unwrap()
        .close_allocation()
        .unwrap()
        .finalize_for_worker()
        .unwrap();
    assert!(result.storage_retained() && !result.completed() && lease_held(&broker));
    original
        .office
        .close_for_stopped_source(super::super::super::tests::end())
        .unwrap();
}

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
