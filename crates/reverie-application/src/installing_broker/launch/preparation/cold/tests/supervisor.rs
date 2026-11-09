//! Real startup, accepted J, detached LIVE owner and fresh canonical intent.
use super::*;

fn service_tree() -> Tree {
    let mut tree = Tree::new();
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw["socket"] = serde_json::json!(tree.root.join("control/supervisor.sock"));
    tree.raw = serde_json::to_vec(&raw).unwrap();
    tree
}
fn company(tree: &Tree, running: bool) {
    tree.write(
        "company.json",
        &serde_json::to_vec(&serde_json::json!({"employees":[{
            "id":EID,"owner":null,"sessionId":SID,"desiredRunning":running
        }]}))
        .unwrap(),
    );
}
fn finish(
    broker: &Arc<InstallingBroker>,
    service: crate::installing_broker::BrokerService,
    office: &Arc<crate::installing_broker::recovered::RecoveredOffice>,
) {
    let end = super::super::super::tests::end();
    if office
        ._phone
        .require_closed_for_resource(
            &broker.storage.runtime,
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .is_err()
    {
        office.close_for_stopped_source(end).unwrap();
    }
    broker.request_stop();
    // A negative baseline still retains the actual live resource/service;
    // this component close cannot stand in for stopped/lease-release proof.
    let _original_service_outcome = service.run();
}
#[test]
fn service_poll_stops_detached_off_session_after_original_j_is_finalized() {
    crate::test_process::owning_case!(
        service_poll_stops_detached_off_session_after_original_j_is_finalized
    );
    let tree = service_tree();
    let broker = Arc::new(broker(&tree));
    tree.write("recovery-names.out", b"");
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    let (_client, cold) = classified(&broker);
    let started = cold.prepare_cold().unwrap();
    let office = started.started.office.clone();
    let closed = started.finalize_for_worker().unwrap();
    assert!(closed.storage_retained() && lease_held(&broker));
    company(&tree, false);
    let polled = service.poll_handler();
    let stopped = tree.root.join("cold-stopped").is_file();
    let retained = lease_held(&broker);
    let registered = !broker.installed.lifecycle().unwrap().guard.is_empty();
    finish(&broker, service, &office);
    polled.unwrap();
    assert!(stopped, "fresh OFF must stop the actual detached CID");
    assert!(
        !retained && !registered,
        "known stop closes Office and returns the same lease"
    );
}
#[test]
fn service_poll_keeps_normal_detached_running_session_and_original_resource() {
    crate::test_process::owning_case!(
        service_poll_keeps_normal_detached_running_session_and_original_resource
    );
    let tree = service_tree();
    let broker = Arc::new(broker(&tree));
    tree.write("recovery-names.out", b"");
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    let (_client, cold) = classified(&broker);
    let started = cold.prepare_cold().unwrap();
    let office = started.started.office.clone();
    started.finalize_for_worker().unwrap();
    let polled = service.poll_handler();
    let stopped = tree.root.join("cold-stopped").exists();
    let retained = lease_held(&broker);
    let registered = broker.installed.lifecycle().unwrap().guard.len();
    finish(&broker, service, &office);
    polled.unwrap();
    assert!(!stopped && retained && registered == 1);
}

#[test]
fn service_poll_does_not_stop_the_same_session_while_a_real_later_j_is_attached() {
    crate::test_process::owning_case!(
        service_poll_does_not_stop_the_same_session_while_a_real_later_j_is_attached
    );
    let tree = service_tree();
    let broker = Arc::new(broker(&tree));
    tree.write("recovery-names.out", b"");
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    let (_client, cold) = classified(&broker);
    let first = cold.prepare_cold().unwrap();
    let office = first.started.office.clone();
    first.finalize_for_worker().unwrap();
    tree.write("pane.out", b"0\n");
    let (_later, server) =
        crate::installing_broker::launch::tests::incoming_as(&broker, b'J', SID, true);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(server).unwrap()
    else {
        panic!("actual later J");
    };
    let inspected = received.begin_ordinary().unwrap().prepare_prefix().unwrap();
    let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
        panic!("actual reuse");
    };
    let attached = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    company(&tree, false);
    let polled = service.poll_handler();
    let stopped = tree.root.join("cold-stopped").exists();
    let held = lease_held(&broker);
    let finalized = attached.finalize_for_worker();
    finish(&broker, service, &office);
    polled.unwrap();
    finalized.unwrap();
    assert!(
        !stopped && held,
        "a real reattachment must finish before supervision may stop it"
    );
}

#[test]
fn service_poll_retains_unknown_stop_and_never_replays_it_while_continuing_to_poll() {
    crate::test_process::owning_case!(
        service_poll_retains_unknown_stop_and_never_replays_it_while_continuing_to_poll
    );
    let tree = service_tree();
    let broker = Arc::new(broker(&tree));
    tree.write("recovery-names.out", b"");
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    let (_client, cold) = classified(&broker);
    let started = cold.prepare_cold().unwrap();
    let office = started.started.office.clone();
    started.finalize_for_worker().unwrap();
    company(&tree, false);
    tree.write("cold-stop-refused", b"fixed owned stop and kill refuse");
    let first = service.poll_handler();
    let calls = fs::read(tree.root.join("calls.txt")).unwrap();
    company(&tree, true);
    let second = service.poll_handler();
    let after = fs::read(tree.root.join("calls.txt")).unwrap();
    let held = lease_held(&broker);
    let pending = broker.installed.lifecycle().unwrap().guard.has_pending();
    let open = office
        ._phone
        .require_closed_for_resource(
            &broker.storage.runtime,
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .is_err();
    let stopping = broker.storage.runtime.cancellation().is_cancelled();
    finish(&broker, service, &office);
    first.unwrap();
    second.unwrap();
    assert_eq!(
        calls, after,
        "polling and new ON intent cannot replay the original unknown stop"
    );
    assert_eq!(
        String::from_utf8(calls)
            .unwrap()
            .lines()
            .filter(|line| line.starts_with("stop\0"))
            .count(),
        1
    );
    assert!(held && pending && open && !stopping);
}
