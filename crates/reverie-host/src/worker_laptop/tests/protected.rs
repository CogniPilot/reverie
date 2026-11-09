//! Real L socket/Hold through actual fixed native create and local phase owners.
//! This proves no Q grant, kernel high/pool membership or readiness/ACK.
use super::*;
use crate::{command_telemetry::CommandTelemetry, worker_reports::WorkerReportService};
#[test]
fn actual_l_created_memory_cli_and_guard_observations_keep_one_original_record() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::protected::actual_l_created_memory_cli_and_guard_observations_keep_one_original_record",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-pane-normal");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, held) = fixture.accepted_protected(&service, "original");
    let (connection, _, _, mut hold) = held.into_parts();
    let (nix, plan, _request, phone) = fixture.resources();
    let workflow = runtime
        .retain_laptop_network_for_connection(&nix, plan, phone, &connection)
        .unwrap_or_else(|failure| panic!("{}", failure.cause()));
    assert_eq!(
        runtime.run_laptop_network(&workflow, end()).unwrap(),
        LaptopNetworkProgress::Ready
    );
    let telemetry = CommandTelemetry::capture(runtime, &fixture.source).unwrap();
    let LaptopCreation::Created(created) =
        runtime.create_laptop(&workflow, &telemetry, end()).unwrap()
    else {
        panic!("actual create")
    };
    let first = runtime
        .observe_protected_created(&created, &connection)
        .unwrap();
    assert!(first.same_created(&created));
    assert_eq!(first.target_session(), &sid());
    let (_other_client, ordinary, mut ordinary_hold) = fixture.accepted(&service, "ordinary");
    assert_eq!(
        runtime
            .observe_protected_created(&created, &ordinary)
            .err()
            .unwrap()
            .code(),
        "RESOURCE_NATIVE_L_CONNECTION_REQUIRED"
    );
    first.assert_current(runtime, &connection).unwrap();
    runtime.publish_laptop_launch(&created).unwrap();
    let ContainerStart::Started(started) = runtime.start_laptop_container(&created, end()).unwrap()
    else {
        panic!("actual start")
    };
    assert!(
        runtime
            .observe_protected_created(&created, &connection)
            .is_err()
    );
    let MemoryConfiguration::Configured(memory) = runtime
        .configure_started_laptop_memory(&started, end())
        .unwrap()
    else {
        panic!("actual unselected-memory phase")
    };
    let configured = runtime
        .observe_protected_memory_configured(&memory, &first, &connection)
        .unwrap();
    assert!(configured.same_created(&first));
    configured.assert_current(runtime, &connection).unwrap();
    let ColdCommit::Committed(cold) = runtime.commit_started_laptop_cold(&memory, end()).unwrap()
    else {
        panic!("actual cold")
    };
    assert!(configured.assert_current(runtime, &connection).is_err());
    let PaneStart::Started(pane) = runtime.start_laptop_pane(&cold, end()).unwrap() else {
        panic!("actual two-command pane")
    };
    let cli = runtime
        .observe_protected_cli_started(&pane, &first, &connection)
        .unwrap();
    assert!(cli.same_created(&first));
    let NixGuardRelease::Released(released) =
        runtime.release_laptop_nix_guard(&pane, end()).unwrap()
    else {
        panic!("actual checked guard")
    };
    assert!(cli.same_released(&released));
    cli.assert_current(runtime, &connection).unwrap();
    assert!(
        runtime
            .observe_protected_cli_started(&pane, &first, &ordinary)
            .is_err()
    );
    ordinary.close_socket_for_worker().unwrap();
    ordinary_hold.release_for_worker().unwrap();
    connection.close_socket_for_worker().unwrap();
    hold.release_for_worker().unwrap();
    service.close(end()).unwrap();
    assert!(
        runtime.close(end()).is_err(),
        "same created resources still counted"
    );
}
