//! Actual report Hold and original fixed native engine, not boolean closure
//! substitution. No Docker/company/pool target or allocation is touched.
use super::*;
use reverie_host::{
    engine_metadata::{CancellationToken, EngineFault, EngineQuery},
    worker_reports::{AcceptedWorkerServiceConnection, WorkerServiceConnection},
};
use std::{io::Write, os::unix::net::UnixStream};

fn setup() -> (std::path::PathBuf, Arc<InstallingBroker>, BrokerService) {
    let (root, broker) = super::super::super::super::recovered::tests::Tree::bootstrap_parts(
        "",
        "admission",
        512,
        4096,
    );
    let broker = Arc::new(broker);
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    (root, broker, service)
}
fn held_record(
    broker: &InstallingBroker,
) -> (
    UnixStream,
    WorkerServiceConnection,
    reverie_host::worker_reports::WorkerLaunchHold,
) {
    let (mut client, server) = UnixStream::pair().unwrap();
    client.write_all(b"M\0\0\0\x02{}").unwrap();
    let snapshot = broker.configuration().unwrap();
    let AcceptedWorkerServiceConnection::Service(connection) = broker
        .reports
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(&broker.telemetry, snapshot.configuration())
        .unwrap()
    else {
        panic!("actual same-record service connection");
    };
    let hold = connection.retain_lifecycle().unwrap();
    assert!(matches!(
        connection.close_socket_for_worker().unwrap(),
        reverie_host::worker_reports::WorkerLaunchClose::SocketClosedLifecycleHeld
    ));
    (client, connection, hold)
}

#[test]
fn actual_retained_report_does_not_seal_same_client_and_public_settlement_keeps_first_stop() {
    crate::test_process::owning_case!(
        actual_retained_report_does_not_seal_same_client_and_public_settlement_keeps_first_stop
    );
    let (root, broker, service) = setup();
    let (client, connection, mut hold) = held_record(&broker);
    broker.request_stop();
    let mut failure = service.run().err().unwrap();
    let original_end = broker.storage.runtime.stop_deadline().unwrap();
    // Query uses exactly the original bound. A fresh cancellation token is only
    // a test oracle for whether this SAME captured client was prematurely sealed.
    let observed = broker.storage.runtime.readonly().query(
        EngineQuery::InventoryIds,
        original_end,
        &CancellationToken::new(),
    );
    let settled = failure.settle_original_native_work();
    let still_same_end = broker.storage.runtime.stop_deadline() == Some(original_end);
    let mut cleanup = Vec::new();
    capture(
        connection.close_socket_for_worker().map(|_| ()),
        &mut cleanup,
    );
    capture(hold.release(original_end), &mut cleanup);
    drop(connection);
    capture(nix::unistd::close(client), &mut cleanup);
    close_known_components(&mut failure.service, original_end, &mut cleanup);
    drop(failure);
    drop(broker);
    // Cleanup is attempted before the regression verdict, including RED.
    assert!(
        cleanup.is_empty(),
        "all cleanup causes: {cleanup:?}; original observation={observed:?}; original settlement={settled:?}"
    );
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(observed.unwrap(), "");
    settled.unwrap();
    assert!(still_same_end);
}

#[test]
fn actual_historical_listener_error_does_not_prevent_known_components_sealing_runtime() {
    crate::test_process::owning_case!(
        actual_historical_listener_error_does_not_prevent_known_components_sealing_runtime
    );
    let (root, broker, mut service) = setup();
    service.listener.close().unwrap();
    let actual_body_error = service.poll_handler().unwrap_err();
    let mut causes = vec![actual_body_error];
    assert!(service.shutdown(&mut causes).is_err());
    let original_end = broker.storage.runtime.stop_deadline().unwrap();
    let observed = broker.storage.runtime.readonly().query(
        EngineQuery::InventoryIds,
        original_end,
        &CancellationToken::new(),
    );
    let mut cleanup = Vec::new();
    close_known_components(&mut service, original_end, &mut cleanup);
    drop(service);
    drop(broker);
    assert!(
        cleanup.is_empty(),
        "all cleanup causes: {cleanup:?}; original sealing observation={observed:?}; original causes={causes:?}"
    );
    std::fs::remove_dir_all(root).unwrap();
    assert!(
        !causes.is_empty(),
        "original actual body error remains negative"
    );
    assert_eq!(observed.unwrap_err().fault(), EngineFault::Busy);
}
fn capture<T, E: std::fmt::Display>(result: Result<T, E>, errors: &mut Vec<String>) {
    if let Err(error) = result {
        errors.push(error.to_string());
    }
}
fn close_known_components(
    service: &mut BrokerService,
    end: std::time::Instant,
    errors: &mut Vec<String>,
) {
    let broker = &service.startup.owner.broker;
    capture(service.listener.close(), errors);
    capture(broker.reports.close(end), errors);
    capture(broker.close_command_telemetry(end), errors);
    capture(broker.close_chat_images(end), errors);
    capture(broker.recovery.close_service_owners(broker, end), errors);
    capture(broker.storage.runtime.close(end), errors);
    if let Some(signals) = &mut service.startup.owner.signals {
        capture(signals.finish_after_runtime_close(), errors);
    }
}
