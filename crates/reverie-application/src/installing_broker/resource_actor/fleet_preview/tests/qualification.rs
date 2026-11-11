//! Actual public producer refusals. No installed OS origin or qualified
//! native preview is manufactured for these controls.
use super::*;

fn connection(broker: &Arc<InstallingBroker>) -> (UnixStream, WorkerServiceConnection) {
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let raw = br#"{"purpose":"resource-fleet-maintenance-v1","version":1,"replyVersion":2}"#;
    client
        .write_all(
            &WorkerFrameHeader::for_payload(b'Q', raw.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(raw).unwrap();
    let AcceptedWorkerServiceConnection::Service(connection) = broker
        .reports
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(
            &broker.telemetry,
            broker.configuration().unwrap().configuration(),
        )
        .unwrap()
    else {
        panic!("actual Q record")
    };
    (client, connection)
}
fn close_broker(broker: &Arc<InstallingBroker>) {
    let end = Instant::now() + Duration::from_secs(3);
    let reports = broker.reports.close(end);
    let telemetry = broker.close_command_telemetry(end);
    let runtime = broker.storage.runtime.close(end);
    reports.unwrap();
    telemetry.unwrap();
    runtime.unwrap();
}

#[test]
fn actual_unopened_origin_cannot_mint_a_qualified_preview_or_consume_b() {
    crate::test_process::owning_case!(
        actual_unopened_origin_cannot_mint_a_qualified_preview_or_consume_b
    );
    let (root, broker, offer) = installation_offer::tests::unopened_shared_fixture();
    let references = Arc::strong_count(&broker);
    let before = std::fs::read(root.join("calls.txt")).ok();
    let view = offer.preparation_view(&broker).unwrap();
    let (mut client, connection) = connection(&broker);
    let failure = broker
        .prepare_fleet_preview(connection, view)
        .err()
        .unwrap();
    let code = failure.primary_error_code();
    let closed = failure.close();
    let known_closed = closed.is_ok();
    drop(closed);
    let released = Arc::strong_count(&broker) == references;
    let b_unchanged = offer.preparation_view(&broker).is_ok();
    let after = std::fs::read(root.join("calls.txt")).ok();
    let mut body = Vec::new();
    let eof = client.read_to_end(&mut body);
    drop(client);
    close_broker(&broker);
    drop(offer);
    drop(broker);
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(code, Some("POOL_INSTALLATION_NATIVE_ORIGIN_RETAINED"));
    assert!(known_closed && released && b_unchanged && eof.is_ok() && body.is_empty());
    assert_eq!(before, after);
}

#[test]
fn foreign_actual_view_refuses_before_origin_reads_and_keeps_both_brokers_closeable() {
    crate::test_process::owning_case!(
        foreign_actual_view_refuses_before_origin_reads_and_keeps_both_brokers_closeable
    );
    let (root, broker, offer) = installation_offer::tests::unopened_shared_fixture();
    let (foreign_root, foreign, foreign_offer) =
        installation_offer::tests::unopened_shared_fixture();
    let references = Arc::strong_count(&foreign);
    let before = (
        std::fs::read(root.join("calls.txt")).ok(),
        std::fs::read(foreign_root.join("calls.txt")).ok(),
    );
    let view = foreign_offer.preparation_view(&foreign).unwrap();
    let (client, connection) = connection(&broker);
    let failure = broker
        .prepare_fleet_preview(connection, view)
        .err()
        .unwrap();
    let code = failure.primary_error_code();
    let closed = failure.close();
    let known_closed = closed.is_ok();
    drop(closed);
    let released = Arc::strong_count(&foreign) == references;
    let unchanged =
        offer.preparation_view(&broker).is_ok() && foreign_offer.preparation_view(&foreign).is_ok();
    let after = (
        std::fs::read(root.join("calls.txt")).ok(),
        std::fs::read(foreign_root.join("calls.txt")).ok(),
    );
    drop(client);
    close_broker(&broker);
    close_broker(&foreign);
    drop(offer);
    drop(foreign_offer);
    drop(broker);
    drop(foreign);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(foreign_root).unwrap();
    assert_eq!(code, Some("FLEET_PREVIEW_ORIGINAL_BINDING_CHANGED"));
    assert!(known_closed && released && unchanged);
    assert_eq!(before, after);
}
