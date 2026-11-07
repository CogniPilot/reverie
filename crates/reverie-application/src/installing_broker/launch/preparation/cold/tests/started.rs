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
    let runtime = &broker.storage.runtime;
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
    let failure = runtime
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
    previous.assert_plan(runtime, &plan).unwrap();
    assert_eq!(plan.storage(), claimed.storage.as_ref().unwrap().paths());
    assert!(!receipt.exists() && lease_held(&broker));
    let borrowed = runtime
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
    let result = finish_returned_inputs(claimed, current, plan, previous, receipt, resources);
    assert!(result.storage_retained() && !result.completed() && lease_held(&broker));
    teardown_fixture_office(&original);
}

/// Only actual returned observations and the original whole claim/lifecycle/J
/// enter this restoration. No lookup or observation is replayed after refusal.
fn finish_returned_inputs(
    claimed: ClaimedWorkerLaunch<'_>,
    current: Arc<ValidatedWorkerSnapshot>,
    plan: ObservedCreatePlan,
    previous: reverie_host::worker_launch::ExistingLaptopInspection,
    receipt: reverie_host::worker_storage::LaunchReceiptObservation,
    resources: EffectiveWorkerConfig,
) -> ReuseHandlerClosed {
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
    reuse
        .prepare_viewer()
        .unwrap()
        .close_allocation()
        .unwrap()
        .finalize_for_worker()
        .unwrap()
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
    teardown_fixture_office(&original);
}

/// Synthetic producer teardown after the assertions; no laptop stop or
/// employee lease release credit follows from this Office-only joined close.
fn teardown_fixture_office(original: &StartedLaptop) {
    original
        .office
        .close_for_stopped_source(super::super::super::tests::end())
        .unwrap();
}

#[test]
fn actual_live_cold_then_stopped_new_j_moves_same_resource_into_ordinary_stop() {
    crate::test_process::owning_case!(
        actual_live_cold_then_stopped_new_j_moves_same_resource_into_ordinary_stop
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (_first_client, first) = classified(&broker);
    let first = first.prepare_cold().unwrap();
    let original = first.started.clone();
    assert!(first.finalize_for_worker().unwrap().storage_retained());
    tree.write("cold-stopped", b"synthetic owned target now stopped");
    let (_client, socket) =
        crate::installing_broker::launch::tests::incoming_as(&broker, b'J', SID, false);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("real new J");
    };
    let admitted = received.begin_ordinary().unwrap();
    let inspected = admitted.prepare_prefix().unwrap();
    let ClassifiedWorkerLaunch::Cold(cold) = inspected.classify_existing().unwrap() else {
        panic!("actual stopped Cold");
    };
    assert!(matches!(cold.target(), ExistingColdTarget::Stopped(_)));
    let mut body = ColdBody::from_classified(cold);
    body.stop_existing().unwrap();
    let Some(Resources::Stopped(stopped)) = &body.resources else {
        panic!("known stopped return");
    };
    assert!(stopped.removal.is_some());
    assert!(!stopped.storage.newly_claimed());
    assert!(body.predecessor_phone.is_some());
    assert!(lease_held(&broker));
    assert!(
        broker
            .storage
            .runtime
            .created_laptop_stop_target(&original.created)
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
    // Only the actual stop purpose may take this box; it remains held through
    // original Office finalization, not released by known stopped metadata.
    teardown_fixture_office(&original);
}

#[test]
fn actual_live_cold_then_completed_new_j_uses_real_process_and_replacement_stop() {
    crate::test_process::owning_case!(
        actual_live_cold_then_completed_new_j_uses_real_process_and_replacement_stop
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let original = completed_predecessor(&tree, &broker);
    let (_client, socket) =
        crate::installing_broker::launch::tests::incoming_as(&broker, b'J', SID, false);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("actual later J");
    };
    let inspected = received.begin_ordinary().unwrap().prepare_prefix().unwrap();
    let ClassifiedWorkerLaunch::Cold(cold) = inspected.classify_existing().unwrap() else {
        panic!("completed running Cold");
    };
    assert!(matches!(
        cold.target(),
        ExistingColdTarget::RunningCompleted(_)
    ));
    let mut body = ColdBody::from_classified(cold);
    body.stop_existing().unwrap();
    let Some(Resources::Stopped(stopped)) = &body.resources else {
        panic!("actual replacement known stopped");
    };
    assert!(stopped.removal.is_some() && !stopped.storage.newly_claimed());
    assert!(matches!(
        body.scope.budget,
        CreationBudget::ReplacementConfirmed
    ));
    assert!(body.predecessor_phone.is_some() && lease_held(&broker));
    assert!(tree.root.join("cold-stopped").is_file());
    assert!(
        broker
            .storage
            .runtime
            .created_laptop_stop_target(&original.created)
            .is_err()
    );
    teardown_fixture_office(&original);
}

fn completed_predecessor(tree: &Tree, broker: &InstallingBroker) -> Arc<StartedLaptop> {
    let (_first_client, first) = classified(broker);
    let first = first.prepare_cold().unwrap();
    let original = first.started.clone();
    assert!(first.finalize_for_worker().unwrap().storage_retained());
    tree.write(
        "cold-running-pid",
        std::process::id().to_string().as_bytes(),
    );
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(tree.root.join("state").join(SID).join("runtime.json")).unwrap(),
    )
    .unwrap();
    fs::write(
        original
            .network
            .paths()
            .home()
            .join(".reverie-launch")
            .join(metadata["exit"].as_str().unwrap()),
        b"0",
    )
    .unwrap();
    original
}
#[test]
fn actual_started_replacement_unknown_keeps_whole_stop_office_lease_and_handler_hold() {
    crate::test_process::owning_case!(
        actual_started_replacement_unknown_keeps_whole_stop_office_lease_and_handler_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let original = completed_predecessor(&tree, &broker);
    tree.write("cold-stop-refused", b"fixed stop and kill children refuse");
    let (_client, socket) =
        crate::installing_broker::launch::tests::incoming_as(&broker, b'J', SID, false);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("actual later J");
    };
    let inspected = received.begin_ordinary().unwrap().prepare_prefix().unwrap();
    let ClassifiedWorkerLaunch::Cold(cold) = inspected.classify_existing().unwrap() else {
        panic!("actual completed running Cold");
    };
    let failed = cold.prepare_cold().err().unwrap();
    assert!(matches!(
        failed.owner.resources,
        Some(Resources::Replacement(_))
    ));
    assert!(failed.owner.creation.is_none() && failed.owner.scope.active.is_some());
    let failure = failed.finalize_for_worker().err().unwrap();
    assert_eq!(failure.request().session().as_str(), SID);
    assert!(failure.cleanup_error_count() > 0 && lease_held(&broker));
    assert!(
        broker
            .close_command_telemetry(super::super::super::tests::end())
            .is_err()
    );
    assert!(!tree.root.join("cold-stopped").exists());
    assert!(
        broker
            .storage
            .runtime
            .created_laptop_stop_target(&original.created)
            .is_err()
    );
    teardown_fixture_office(&original);
}
