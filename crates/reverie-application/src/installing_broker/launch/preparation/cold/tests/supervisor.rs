//! Real startup, accepted J, detached LIVE owner and fresh canonical intent.
use super::*;

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
    let tree = Tree::new();
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
    let tree = Tree::new();
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
