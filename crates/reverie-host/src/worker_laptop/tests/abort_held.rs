//! No native dispatch is synthesized to recover a genuine Held record.
use super::*;
use crate::worker_reports::WorkerReportService;

fn close_returned(
    fixture: &Fixture,
    returned: (NixReturned, ObservedCreatePlan, WorkerRequest, OfficePhone),
) {
    let (nix, plan, request, phone) = returned;
    assert_eq!(plan.session(), request.session());
    fixture.office.close_phone(&phone, end()).unwrap();
    let (guard, storage, outcome) = nix.into_parts();
    assert!(outcome.is_ok());
    plan.assert_storage_owner(fixture.runtime(), &storage)
        .unwrap();
    guard.close().unwrap();
    storage
        .close(end())
        .unwrap_or_else(|failure| panic!("{}", failure.cause()));
}

#[test]
fn held_network_abort_guard_drop_keeps_counted_original_lease_then_returns_once_without_dispatch() {
    let fixture = Fixture::employee("created-memory");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (_client, connection, mut hold) = fixture.accepted(&service, "opencode");
    let (nix, plan, _request, phone) = fixture.resources();
    let runtime = fixture.runtime();
    let workflow = runtime
        .retain_laptop_network_for_connection(&nix, plan, phone, &connection)
        .unwrap_or_else(|failure| panic!("{}", failure.cause()));
    drop(
        runtime
            .abort_held_laptop_network(&workflow, &connection)
            .unwrap(),
    );
    assert_eq!(runtime.laptop_workflows().records.lock().unwrap().len(), 1);
    assert!(crate::worker_storage::StorageLease::acquire_launch(&fixture.source, &sid()).is_err());
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert!(!trace.lines().any(|line| line.starts_with("network\0")));
    connection.close_socket(end()).unwrap();
    // Cleanup checks exact identity, including after forward socket closure.
    let returned = runtime
        .abort_held_laptop_network(&workflow, &connection)
        .unwrap()
        .into_parts();
    assert!(
        runtime
            .laptop_workflows()
            .records
            .lock()
            .unwrap()
            .is_empty()
    );
    assert!(runtime.run_laptop_network(&workflow, end()).is_err());
    assert!(
        runtime
            .abort_held_laptop_network(&workflow, &connection)
            .is_err()
    );
    close_returned(&fixture, returned);
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
}

#[test]
fn held_network_abort_refuses_second_same_sid_j_and_every_already_dispatched_phase() {
    let fixture = Fixture::employee("created-memory");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (_client, connection, mut hold) = fixture.accepted(&service, "opencode");
    let (_other_client, other, mut other_hold) = fixture.accepted(&service, "opencode");
    let (nix, plan, _request, phone) = fixture.resources();
    let runtime = fixture.runtime();
    let workflow = runtime
        .retain_laptop_network_for_connection(&nix, plan, phone, &connection)
        .unwrap_or_else(|failure| panic!("{}", failure.cause()));
    assert!(
        runtime
            .abort_held_laptop_network(&workflow, &other)
            .is_err()
    );
    assert_eq!(runtime.laptop_workflows().records.lock().unwrap().len(), 1);
    assert_eq!(
        runtime
            .run_laptop_network_for_connection(&workflow, &connection)
            .unwrap(),
        LaptopNetworkProgress::Ready
    );
    assert!(
        runtime
            .abort_held_laptop_network(&workflow, &connection)
            .is_err()
    );
    let returned = runtime
        .reclaim_laptop_network(workflow)
        .unwrap_or_else(|failure| panic!("{}", failure.cause()));
    let (nix, plan, request, phone, outcome) = returned.into_parts();
    assert!(outcome.is_ok());
    close_returned(&fixture, (nix, plan, request, phone));
    connection.close_socket(end()).unwrap();
    other.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    other_hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
