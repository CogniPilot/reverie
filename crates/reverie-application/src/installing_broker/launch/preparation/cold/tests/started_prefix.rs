//! Genuine later-J prefix failures finish their own handlers while the same
//! Created laptop and physical employee lease remain retained.
use super::*;
use std::io::Read;

fn predecessor(tree: &Tree, broker: &InstallingBroker) -> Arc<StartedLaptop> {
    let (_client, first) = classified(broker);
    let first = first.prepare_cold().unwrap();
    let original = first.started.clone();
    assert!(first.finalize_for_worker().unwrap().storage_retained());
    tree.write("pane.out", b"0\n");
    original
}
fn later(broker: &InstallingBroker) -> (std::os::unix::net::UnixStream, InspectedWorkerLaunch<'_>) {
    let (client, socket) =
        crate::installing_broker::launch::tests::incoming_as(broker, b'J', SID, true);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("actual later J");
    };
    (
        client,
        received.begin_ordinary().unwrap().prepare_prefix().unwrap(),
    )
}
fn close_fixture_office(original: &StartedLaptop) {
    original
        .office
        .close_for_stopped_source(super::super::super::tests::end())
        .unwrap();
}
#[test]
fn actual_started_prefix_failure_then_next_j_keeps_same_laptop_and_releases_each_handler() {
    crate::test_process::owning_case!(
        actual_started_prefix_failure_then_next_j_keeps_same_laptop_and_releases_each_handler
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let original = predecessor(&tree, &broker);
    for _ in 0..2 {
        let (mut client, inspected) = later(&broker);
        tree.write("pane.out", b"unavailable");
        let failure = inspected.classify_existing().err().unwrap();
        let closed = failure.finalize_for_worker().unwrap();
        assert!(
            closed.storage_retained() && !closed.completed() && closed.primary_error().is_some()
        );
        assert!(lease_held(&broker));
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
        tree.write("pane.out", b"0\n");
    }
    let (_client, inspected) = later(&broker);
    let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
        panic!("same original laptop still reusable");
    };
    assert!(
        reuse
            .finalize_classified_for_worker()
            .unwrap()
            .storage_retained()
    );
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("create\0"))
            .count(),
        1
    );
    assert!(
        !calls
            .lines()
            .any(|line| line.starts_with("stop\0") || line.starts_with("kill\0"))
    );
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
    close_fixture_office(&original);
}
#[test]
fn actual_started_prefix_negative_liveness_keeps_created_office_lease_and_hold() {
    crate::test_process::owning_case!(
        actual_started_prefix_negative_liveness_keeps_created_office_lease_and_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let original = predecessor(&tree, &broker);
    let (_client, inspected) = later(&broker);
    let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
        panic!("genuine running classification");
    };
    tree.write(
        "cold-stopped",
        b"external fixture stopped after classification",
    );
    let retained = reuse.finalize_classified_for_worker().err().unwrap();
    assert!(retained.cleanup_error_count() > 0 && lease_held(&broker));
    assert!(
        broker
            .close_command_telemetry(super::super::super::tests::end())
            .is_err()
    );
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
    close_fixture_office(&original);
}

#[test]
fn actual_started_prefix_fence_survives_cached_cleanup_aliases_without_global_stop() {
    crate::test_process::owning_case!(
        actual_started_prefix_fence_survives_cached_cleanup_aliases_without_global_stop
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let original = predecessor(&tree, &broker);
    let (_client, inspected) = later(&broker);
    let InspectedWorkerLaunch {
        observed,
        previous: _previous,
    } = inspected;
    let observe::ObservedWorkerLaunch {
        claimed,
        current: _current,
        plan,
    } = observed;
    let runtime = &broker.storage.runtime;
    let mut plan = Some(plan);
    let mut finalizer = runtime
        .retain_started_final_storage(
            &original.created,
            &mut plan,
            &claimed.preparing.admitted.request.connection,
        )
        .unwrap();
    let end = super::super::super::tests::end();
    let guard = runtime.cleanup_created_laptop_nix_guard(&original.created, end);
    let viewer = runtime.close_created_laptop_viewer_for_worker(&original.created);
    let request = runtime.cleanup_created_laptop_request(&original.created);
    let reopened = runtime
        .borrow_started_laptop_storage(
            &original.created,
            &claimed.preparing.admitted.request.connection,
        )
        .is_ok();
    let stopped = runtime.stop_created_laptop(&original.created, end);
    assert!(runtime.stop_deadline().is_none());
    assert!(lease_held(&broker));
    assert!(
        !reopened,
        "cached cleanup aliases must not reopen this original record"
    );
    assert!(guard.is_err() && viewer.is_err() && request.is_err() && stopped.is_err());
    assert!(finalizer.observe(runtime).unwrap().is_live());
    assert!(
        broker.close_command_telemetry(end).is_err(),
        "actual later J/Hold remains owned"
    );
    close_fixture_office(&original);
}
