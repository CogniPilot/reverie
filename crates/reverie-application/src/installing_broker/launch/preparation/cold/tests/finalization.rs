//! Genuine accepted owners through the public consuming finally. The engine
//! child supplies controlled kernel-independent Docker observations only.
use super::*;
use std::io::Read;

fn request_closed(client: &mut std::os::unix::net::UnixStream) {
    client
        .set_read_timeout(Some(std::time::Duration::from_secs(1)))
        .unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
}
#[test]
fn genuine_undispatched_network_abort_returns_original_owners_without_network_or_create_effects() {
    crate::test_process::owning_case!(genuine_undispatched_network_abort_returns_original_owners_without_network_or_create_effects);
    let tree = Tree::new();
    let broker = broker(&tree);
    let (mut client, cold) = classified(&broker);
    let mut owner = ColdBody::from_classified(cold);
    owner.stop_existing().unwrap();
    owner.copy_nix().unwrap();
    owner.retain_network().unwrap();
    assert!(matches!(owner.resources, Some(Resources::NetworkHeld(_))));
    let phone = owner.office.as_ref().unwrap().owner().clone();
    drop(owner.lifecycle.take());
    let failure = Box::new(ColdLaunchFailure {
        owner,
        cause: ColdError::Refused("OWNED_CALLER_ABORT_BEFORE_NETWORK_DISPATCH"),
    });
    let closed = failure.finalize_for_worker().unwrap();
    assert!(!closed.completed() && !closed.storage_retained() && !lease_held(&broker));
    phone
        ._phone
        .require_closed_for_resource(
            &broker.storage.runtime,
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .unwrap();
    request_closed(&mut client);
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(
        !calls
            .lines()
            .any(|line| line.starts_with("create\0") || line.starts_with("network\0create\0"))
    );
    broker
        .close_command_telemetry(super::super::super::tests::end())
        .unwrap();
}
#[test]
fn known_ready_network_caller_abort_restores_plan_then_closes_actual_office_lease_and_hold() {
    crate::test_process::owning_case!(
        known_ready_network_caller_abort_restores_plan_then_closes_actual_office_lease_and_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (mut client, cold) = classified(&broker);
    let mut owner = ColdBody::from_classified(cold);
    owner.stop_existing().unwrap();
    owner.copy_nix().unwrap();
    owner.prepare_network().unwrap();
    assert!(owner.creation.is_none() && matches!(owner.resources, Some(Resources::Network(_))));
    assert!(lease_held(&broker));
    drop(owner.lifecycle.take());
    let failure = Box::new(ColdLaunchFailure {
        owner,
        cause: ColdError::Refused("OWNED_CALLER_ABORT_BEFORE_CREATE"),
    });
    let closed = failure.finalize_for_worker().unwrap();
    assert!(!closed.completed() && !closed.storage_retained());
    assert!(closed.primary_error().is_some() && !lease_held(&broker));
    request_closed(&mut client);
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(calls.contains("ps\0--all\0--no-trunc\0--format\0{{.ID}} {{.Names}}"));
    assert!(
        !calls
            .lines()
            .any(|line| line.starts_with("create\0") || line.starts_with("stop\0"))
    );
    broker
        .close_command_telemetry(super::super::super::tests::end())
        .unwrap();
}
#[test]
fn live_started_finally_closes_only_handler_and_preserves_actual_office_and_employee_lease() {
    crate::test_process::owning_case!(
        live_started_finally_closes_only_handler_and_preserves_actual_office_and_employee_lease
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (mut client, cold) = classified(&broker);
    let closed = cold.prepare_cold().unwrap();
    let office = closed.started.office.clone();
    let native = closed.started.network.clone();
    let result = closed.finalize_for_worker().unwrap();
    assert!(!result.completed() && result.storage_retained());
    assert!(lease_held(&broker));
    assert!(
        office
            ._phone
            .require_closed_for_resource(
                &broker.storage.runtime,
                &ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
    );
    assert_eq!(broker.installed.lifecycle().unwrap().guard.len(), 1);
    request_closed(&mut client);
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(
        !calls
            .lines()
            .any(|line| line.starts_with("stop\0") || line.starts_with("kill\0"))
    );
    // Fixture-only producer teardown after assertions; no stopped/lease credit.
    office
        .close_for_stopped_source(super::super::super::tests::end())
        .unwrap();
    assert!(lease_held(&broker));
    drop(native);
}
#[test]
fn completed_started_finally_stops_actual_created_cid_and_returns_same_lease_after_office_join() {
    crate::test_process::owning_case!(
        completed_started_finally_stops_actual_created_cid_and_returns_same_lease_after_office_join
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (mut client, cold) = classified(&broker);
    let closed = cold.prepare_cold().unwrap();
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(tree.root.join("state").join(SID).join("runtime.json")).unwrap(),
    )
    .unwrap();
    let exit = metadata["exit"].as_str().unwrap();
    fs::write(
        closed
            .started
            .network
            .paths()
            .home()
            .join(".reverie-launch")
            .join(exit),
        b"0",
    )
    .unwrap();
    let office = closed.started.office.clone();
    let result = closed.finalize_for_worker().unwrap();
    assert!(result.completed() && !result.storage_retained());
    assert!(!lease_held(&broker));
    office
        ._phone
        .require_closed_for_resource(
            &broker.storage.runtime,
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .unwrap();
    assert!(broker.installed.lifecycle().unwrap().guard.is_empty());
    assert!(tree.root.join("cold-stopped").is_file());
    request_closed(&mut client);
    broker
        .close_command_telemetry(super::super::super::tests::end())
        .unwrap();
}
#[test]
fn uncertain_create_finally_closes_socket_but_keeps_actual_box_office_and_counted_hold() {
    crate::test_process::owning_case!(
        uncertain_create_finally_closes_socket_but_keeps_actual_box_office_and_counted_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("cold-create-nonzero", b"actual fixed create child nonzero");
    let (mut client, cold) = classified(&broker);
    let failure = cold.prepare_cold().err().unwrap();
    let office = failure.owner.office.as_ref().unwrap().owner().clone();
    let retained = failure.finalize_for_worker().err().unwrap();
    assert!(retained.cleanup_error_count() > 0 && lease_held(&broker));
    assert!(
        office
            ._phone
            .require_closed_for_resource(
                &broker.storage.runtime,
                &ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
    );
    request_closed(&mut client);
    assert!(
        broker
            .close_command_telemetry(super::super::super::tests::end())
            .is_err()
    );
    // Actual unknown resources/Hold remain retained; only the synthetic phone
    // producer is settled for owning-process teardown after these assertions.
    office
        .close_for_stopped_source(super::super::super::tests::end())
        .unwrap();
    drop(retained);
}
#[test]
fn generic_native_stopped_without_receipt_retains_office_registration_box_and_hold() {
    crate::test_process::owning_case!(
        generic_native_stopped_without_receipt_retains_office_registration_box_and_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (mut client, cold) = classified(&broker);
    let closed = cold.prepare_cold().unwrap();
    let target = closed
        .started
        .network
        .created_target(&closed.started.created)
        .unwrap();
    let admission = broker.admit_ordinary_stop(&target).unwrap();
    let stopped = closed
        .started
        .network
        .stop_created_under_admission(
            &closed.started.created,
            &closed.scope.preparing.admitted.request.connection,
            &admission,
            &broker,
        )
        .unwrap();
    assert!(matches!(
        stopped,
        reverie_host::worker_laptop::CreatedCleanup::Stopped(_)
    ));
    admission.close().unwrap();
    let office = closed.started.office.clone();
    let retained = closed.finalize_for_worker().err().unwrap();
    assert!(retained.to_string().contains("WORKER_COLD_OFFICE_RETAINED"));
    assert!(lease_held(&broker));
    assert_eq!(broker.installed.lifecycle().unwrap().guard.len(), 1);
    assert!(
        office
            ._phone
            .require_closed_for_resource(
                &broker.storage.runtime,
                &ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
    );
    request_closed(&mut client);
    assert!(
        broker
            .close_command_telemetry(super::super::super::tests::end())
            .is_err()
    );
    // No completion/Service owner authorized ending the producer. Synthetic
    // fixture teardown below leaves the real resource and Hold retained.
    office
        .close_for_stopped_source(super::super::super::tests::end())
        .unwrap();
    drop(retained);
}
